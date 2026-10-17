package kiro

// Credential orchestration: which of this machine's Kiro sessions to use, and
// when a refresh is written back. The network half stays in refreshToken.
// This is the Go port of ns-kiro-core's oauth.ts (refreshKiroTokenInternal
// and resolveKiroCredentials).

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"

	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
	"github.com/ngosangns/ns-bridge/go/internal/kirocli"
	"github.com/ngosangns/ns-bridge/go/internal/kiroide"
	"github.com/ngosangns/ns-bridge/go/internal/logx"
	"github.com/ngosangns/ns-bridge/go/internal/redact"
)

// refreshSession is refreshKiroTokenInternal. The caller (the TypeScript
// facade) schedules the model-catalog refresh afterwards; this process exits
// with the call, so it does not.
func refreshSession(ctx context.Context, raw json.RawMessage) (any, error) {
	var req credentialsRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, fmt.Errorf("kiro refreshSession request: %v", err)
	}
	c, err := req.credentials()
	if err != nil {
		return nil, err
	}
	if c.AuthMethod == "apikey" || strings.HasPrefix(c.Access, "ksk_") {
		return credObject(c), nil
	}

	method := credentialAuthMethod(c)
	cliFresh := cliFamily(method, false)
	cliStale := cliFamily(method, true)
	var ideFresh, ideStale *kiroCredentials
	if method == "idc" {
		ideFresh = fromIDE(kiroide.Get())
		ideStale = fromIDE(kiroide.GetAllowExpired())
	}
	cliIsThis := sameLogin(cliFresh, cliStale, c.Refresh)
	ideIsThis := sameLogin(ideFresh, ideStale, c.Refresh)

	var replacement *kiroCredentials
	switch {
	case cliIsThis:
		replacement = cliFresh
	case ideIsThis:
		replacement = ideFresh
	case kiroAuthSource() == "ide":
		replacement = firstCred(ideFresh, cliFresh)
	default:
		replacement = firstCred(cliFresh, ideFresh)
	}
	if replacement != nil {
		return credObject(replacement), nil
	}

	refreshed, refreshErr := refreshDirect(ctx, c)
	if refreshErr == nil {
		// An IDE login must not be written into the kiro-cli store.
		if !ideIsThis {
			saveObject(refreshed)
		}
		return refreshed, nil
	}

	// The CLI may have rotated between the pre-check and the network call.
	if retry := cliFamily(method, false); retry != nil {
		return credObject(retry), nil
	}
	// A newer refresh token whose access token is already expired.
	if cliStale != nil && cliStale.Refresh != c.Refresh {
		if again, err2 := refreshDirect(ctx, cliStale); err2 == nil {
			saveObject(again)
			return again, nil
		}
	}

	// expires carries a 5-minute buffer, so the access token may still work.
	actual := c.Expires + expiresBufferMs
	if c.Access != "" && nowMs() < actual {
		out := credObject(c)
		if c.raw != nil {
			out = cloneObject(c.raw)
		}
		out.Set("expires", actual)
		return out, nil
	}
	return nil, refreshErr
}

// resolveCredentials is resolveKiroCredentials. A result that came from
// refreshing a stale session carries kiroSessionRefreshed so the facade can
// schedule the catalog refresh it used to schedule inside refreshKiroToken.
func resolveCredentials(ctx context.Context, _ json.RawMessage) (any, error) {
	cli := credStore{fresh: fromCLI(kirocli.GetCredentials()), stale: fromCLI(kirocli.GetCredentialsAllowExpired())}
	ide := credStore{fresh: fromIDE(kiroide.Get()), stale: fromIDE(kiroide.GetAllowExpired())}
	stores := []credStore{cli, ide}
	if kiroAuthSource() == "ide" {
		stores = []credStore{ide, cli}
	}
	var last error
	for _, s := range stores {
		if s.fresh != nil {
			return credObject(s.fresh), nil
		}
		if s.stale == nil {
			continue
		}
		refreshed, err := refreshSession(ctx, credentialsRaw(s.stale))
		if err != nil {
			last = err
			logx.Warn(fmt.Sprintf("[kiro-core] Kiro session refresh failed: %s", redact.Kiro(err.Error())))
			continue
		}
		obj, _ := refreshed.(*jsjson.Object)
		if obj == nil {
			obj = credObject(s.stale)
		}
		obj.Set("kiroSessionRefreshed", true)
		return obj, nil
	}
	if last != nil {
		return nil, last
	}
	return nil, nil
}

type credStore struct {
	fresh *kiroCredentials
	stale *kiroCredentials
}

func credentialAuthMethod(c *kiroCredentials) string {
	if c.AuthMethod != "" {
		return c.AuthMethod
	}
	parts := strings.Split(c.Refresh, "|")
	if parts[len(parts)-1] == "desktop" {
		return "desktop"
	}
	return "idc"
}

func kiroAuthSource() string {
	configured := strings.ToLower(strings.TrimSpace(os.Getenv("KIRO_AUTH_SOURCE")))
	if configured == "" {
		return "cli"
	}
	if configured == "cli" || configured == "ide" {
		return configured
	}
	logx.Warn(fmt.Sprintf("[kiro-core] Ignoring KIRO_AUTH_SOURCE=%s: expected \"cli\" or \"ide\".", configured))
	return "cli"
}

func cliFamily(method string, allowExpired bool) *kiroCredentials {
	if method == "desktop" {
		if allowExpired {
			return fromCLI(kirocli.GetSocialTokenAllowExpired())
		}
		return fromCLI(kirocli.GetSocialToken())
	}
	if allowExpired {
		return fromCLI(kirocli.GetIDCAllowExpired())
	}
	return fromCLI(kirocli.GetIDC())
}

func fromCLI(c *kirocli.Credentials) *kiroCredentials {
	if c == nil {
		return nil
	}
	return &kiroCredentials{
		Access: c.Access, Refresh: c.Refresh, Expires: c.Expires,
		ClientID: c.ClientID, ClientSecret: c.ClientSecret, Region: c.Region,
		AuthMethod: c.AuthMethod, ProfileArn: c.ProfileArn,
	}
}

func fromIDE(c *kiroide.Credentials) *kiroCredentials {
	if c == nil {
		return nil
	}
	return &kiroCredentials{
		Access: c.Access, Refresh: c.Refresh, Expires: c.Expires,
		ClientID: c.ClientID, ClientSecret: c.ClientSecret, Region: c.Region,
		AuthMethod: c.AuthMethod,
	}
}

func sameLogin(fresh, stale *kiroCredentials, refresh string) bool {
	switch {
	case fresh != nil:
		return fresh.Refresh == refresh
	case stale != nil:
		return stale.Refresh == refresh
	default:
		return false
	}
}

func firstCred(a, b *kiroCredentials) *kiroCredentials {
	if a != nil {
		return a
	}
	return b
}

func credObject(c *kiroCredentials) *jsjson.Object {
	if c.raw != nil {
		return c.raw
	}
	o := jsjson.NewObject()
	o.Set("access", c.Access)
	o.Set("refresh", c.Refresh)
	if math.IsNaN(c.Expires) {
		o.Set("expires", nil)
	} else {
		o.Set("expires", c.Expires)
	}
	o.Set("clientId", c.ClientID)
	o.Set("clientSecret", c.ClientSecret)
	o.Set("region", c.Region)
	o.Set("authMethod", c.AuthMethod)
	if c.ProfileArn != "" {
		o.Set("profileArn", c.ProfileArn)
	}
	if c.StartURL != "" {
		o.Set("startUrl", c.StartURL)
	}
	if c.IsEnterprise != nil {
		o.Set("isEnterprise", *c.IsEnterprise)
	}
	return o
}

func cloneObject(o *jsjson.Object) *jsjson.Object {
	parsed, err := jsjson.Parse([]byte(jsjson.Stringify(o)))
	if err != nil {
		return jsjson.NewObject()
	}
	obj, _ := parsed.(*jsjson.Object)
	if obj == nil {
		return jsjson.NewObject()
	}
	return obj
}

// credentialsRaw is a refreshSession request. Empty profile maps keep the
// call off the process-state file: a token refresh does not resolve profiles.
func credentialsRaw(c *kiroCredentials) json.RawMessage {
	req := jsjson.NewObject()
	req.Set("credentials", credObject(c))
	req.Set("profileArnCache", map[string]string{})
	req.Set("profileRegions", map[string]string{})
	return json.RawMessage(jsjson.Stringify(req))
}

func refreshDirect(ctx context.Context, c *kiroCredentials) (*jsjson.Object, error) {
	result, err := refreshToken(ctx, credentialsRaw(c))
	if err != nil {
		return nil, err
	}
	obj, _ := result.(*jsjson.Object)
	if obj == nil {
		return nil, fmt.Errorf("token refresh returned no credentials")
	}
	return obj, nil
}

func saveObject(obj *jsjson.Object) {
	var c kiroCredentials
	if err := json.Unmarshal([]byte(jsjson.Stringify(obj)), &c); err != nil {
		return
	}
	kirocli.SaveCredentials(&kirocli.Credentials{
		Access: c.Access, Refresh: c.Refresh, Expires: c.Expires,
		ClientID: c.ClientID, ClientSecret: c.ClientSecret, Region: c.Region,
		AuthMethod: c.AuthMethod, ProfileArn: c.ProfileArn,
	})
}
