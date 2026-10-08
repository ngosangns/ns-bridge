package kiro

// One-shot operations (`ns-bridge call --vendor kiro --op <op>`): the model
// catalog refresh that feeds the disk cache getCachedModels reads, the usage
// report, and the network half of a token refresh.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ngosangns/ns-bridge/go/internal/jsjson"
	"github.com/ngosangns/ns-bridge/go/internal/jsstr"
	"github.com/ngosangns/ns-bridge/go/internal/sidecar"
)

// Call implements sidecar.Caller.
func (Vendor) Call(ctx context.Context, op string, raw json.RawMessage) (any, error) {
	var (
		result any
		err    error
	)
	switch op {
	case "refreshModels":
		result, err = refreshModels(ctx, raw)
	case "usage":
		result, err = fetchUsage(ctx, raw)
	case "refreshToken":
		result, err = refreshToken(ctx, raw)
	default:
		return nil, sidecar.ErrUnknownOp
	}
	if err != nil && ctx.Err() == nil {
		return nil, toBridgeError(err)
	}
	return result, err
}

// nowMs is Date.now(); swappable in tests.
var nowMs = func() float64 { return float64(time.Now().UnixMilli()) }

var apiRegionMap = map[string]string{
	"sa-east-1": "us-east-1", "us-west-1": "us-east-1", "us-west-2": "us-east-1", "us-east-2": "us-east-1",
	"ap-southeast-1": "us-east-1", "ap-southeast-2": "us-east-1", "ap-northeast-1": "us-east-1",
	"ap-northeast-2": "us-east-1", "ap-south-1": "us-east-1",
	"eu-west-1": "eu-central-1", "eu-west-2": "eu-central-1", "eu-west-3": "eu-central-1",
	"eu-north-1": "eu-central-1", "eu-south-1": "eu-central-1", "eu-south-2": "eu-central-1",
	"eu-central-2": "eu-central-1",
}

// resolveAPIRegion is resolveApiRegion.
func resolveAPIRegion(sso string) string {
	if sso == "" {
		return "us-east-1"
	}
	if r, ok := apiRegionMap[sso]; ok {
		return r
	}
	return sso
}

// opSession is the per-call state shared by the ops: the profile caches the
// facade seeded, which go back with the result.
type opState struct {
	ProfileArnCache map[string]string `json:"profileArnCache"`
	ProfileRegions  map[string]string `json:"profileRegions"`
}

func (o opState) session() *session {
	s := &session{client: httpClient(), profiles: newProfileCache(o.ProfileArnCache)}
	for k, v := range o.ProfileRegions {
		s.profiles.regions[k] = v
	}
	return s
}

// resolveProfile is resolveKiroProfileArn(auth, provided).
func (s *session) resolveProfile(ctx context.Context, a managementAuth, provided string) (string, error) {
	if env := strings.TrimSpace(os.Getenv("KIRO_PROFILE_ARN")); env != "" {
		return env, nil
	}
	if provided != "" {
		debugLog("profile.resolve", map[string]any{"source": "provided", "arn": provided})
		return provided, nil
	}
	return s.resolveProfileArn(ctx, a)
}

func (s *session) profileState(out *jsjson.Object) {
	if len(s.profiles.changes) > 0 {
		changes := jsjson.NewObject()
		for k, v := range s.profiles.changes {
			if v == nil {
				changes.Set(k, nil)
			} else {
				changes.Set(k, *v)
			}
		}
		out.Set("kiroProfileArns", changes)
	}
	if len(s.profiles.regions) > 0 {
		regions := jsjson.NewObject()
		for k, v := range s.profiles.regions {
			regions.Set(k, v)
		}
		out.Set("kiroProfileRegions", regions)
	}
}

// ---------------------------------------------------------------- catalog

type knownModel struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Input             []string `json:"input"`
	FirstTokenTimeout float64  `json:"firstTokenTimeout"`
}

type refreshModelsRequest struct {
	opState
	AccessToken string       `json:"accessToken"`
	Region      string       `json:"region"`
	ProfileArn  string       `json:"profileArn"`
	Known       []knownModel `json:"known"`
	CachePath   string       `json:"cachePath"`
}

const (
	cacheVersion         = 1
	cacheSource          = "ns-kiro-provider-management"
	defaultContextWindow = 200_000
	defaultMaxTokens     = 8_192
)

var reasoningFamilyMarkers = []string{"opus", "sonnet", "fable", "coder", "deepseek", "gpt", "glm", "qwen"}
var verifiedImageModelIDs = map[string]bool{"gpt-5.6-luna": true}
var dottedVersionPattern = regexp.MustCompile(`(\d)\.(\d)`)

// refreshModels is updateKiroModelsCache: fetch the catalog where the profile
// lives, map it, attach kiro-cli's billing rates, and rewrite the disk cache.
func refreshModels(ctx context.Context, raw json.RawMessage) (any, error) {
	var req refreshModelsRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, fmt.Errorf("kiro refreshModels request: %v", err)
	}
	if req.CachePath == "" {
		home, _ := os.UserHomeDir()
		req.CachePath = filepath.Join(home, ".ns-kiro-provider-models-cache.json")
	}
	s := req.session()
	auth := managementAuth{req.AccessToken, req.Region}
	profileArn, err := s.resolveProfile(ctx, auth, req.ProfileArn)
	if err != nil {
		return nil, err
	}
	region := auth.region
	if isAPIKey(auth.accessToken) {
		region = apiKeyRegion
	} else if r, ok := s.profiles.regions[profileCacheKey(auth)]; ok {
		region = r
	}
	catalog, err := s.listAvailableModels(ctx, managementAuth{auth.accessToken, region}, profileArn)
	if err != nil {
		return nil, err
	}
	models, err := mapCatalogModels(catalog, req.Region, kiroCliModelRates(ctx), req.Known)
	if err != nil {
		return nil, err
	}

	cache := readManagementCache(req.CachePath)
	if cache == nil {
		cache = jsjson.NewObject()
		cache.Set("version", float64(cacheVersion))
		cache.Set("source", cacheSource)
		cache.Set("regions", jsjson.NewObject())
	}
	entry := jsjson.NewObject()
	entry.Set("region", req.Region)
	entry.Set("fetchedAt", nowMs())
	entry.Set("models", models)
	regions, _ := cache.Get("regions")
	regions.(*jsjson.Object).Set(req.Region, entry)
	if err := writeManagementCache(req.CachePath, cache); err != nil {
		return nil, err
	}

	out := jsjson.NewObject()
	out.Set("region", req.Region)
	out.Set("models", models)
	s.profileState(out)
	return out, nil
}

// listAvailableModels is listAvailableModels; the response keeps its key order.
func (s *session) listAvailableModels(ctx context.Context, a managementAuth, profileArn string) ([]jsjson.Value, error) {
	var raw json.RawMessage
	err := s.requestManagement(ctx, a, "ListAvailableModels", "List-Available-Models", http.MethodGet,
		map[string]string{"origin": "KIRO_CLI", "profileArn": profileArn}, &raw)
	if err != nil {
		return nil, err
	}
	parsed, err := jsjson.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("Kiro management ListAvailableModels returned invalid JSON in %s", a.region)
	}
	var models []jsjson.Value
	if obj, ok := parsed.(*jsjson.Object); ok {
		v, _ := obj.Get("models")
		models, _ = v.([]jsjson.Value)
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("Kiro management ListAvailableModels returned no models in %s", a.region)
	}
	for _, m := range models {
		obj, ok := m.(*jsjson.Object)
		if !ok {
			return nil, fmt.Errorf("Kiro management ListAvailableModels returned an invalid catalog in %s", a.region)
		}
		id, _ := obj.Get("modelId")
		if s, ok := id.(string); !ok || s == "" {
			return nil, fmt.Errorf("Kiro management ListAvailableModels returned an invalid catalog in %s", a.region)
		}
	}
	return models, nil
}

type modelRate struct {
	multiplier float64
	unit       string
}

// kiroCliModelRates is getKiroCliModelRates: billing weights from
// `kiro-cli chat --list-models --format json`, nil when unavailable.
func kiroCliModelRates(ctx context.Context) map[string]modelRate {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	raw, err := exec.CommandContext(ctx, "kiro-cli", "chat", "--list-models", "--format", "json").Output()
	if err != nil {
		debugLog("models.rates", map[string]any{"source": "kiro-cli", "error": err.Error()})
		return nil
	}
	var parsed struct {
		Models []struct {
			ModelID        any `json:"model_id"`
			RateMultiplier any `json:"rate_multiplier"`
			RateUnit       any `json:"rate_unit"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.Models == nil {
		return nil
	}
	rates := map[string]modelRate{}
	for _, m := range parsed.Models {
		id, _ := m.ModelID.(string)
		mult, ok := m.RateMultiplier.(float64)
		if id == "" || !ok || math.IsInf(mult, 0) || math.IsNaN(mult) || mult <= 0 {
			continue
		}
		unit, _ := m.RateUnit.(string)
		rates[id] = modelRate{multiplier: mult, unit: unit}
	}
	if len(rates) == 0 {
		return nil
	}
	return rates
}

func isPositive(v jsjson.Value) bool {
	f, ok := v.(float64)
	return ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f > 0
}

func humanizeModelID(id string) string {
	words := strings.Split(id, "-")
	for i, w := range words {
		if w != "" {
			r := []rune(w)
			words[i] = strings.ToUpper(string(r[0])) + string(r[1:])
		}
	}
	return strings.Join(words, " ")
}

func hasReasoningFamilyFallback(id string) bool {
	id = strings.ToLower(id)
	if id == "auto" {
		return true
	}
	for _, m := range reasoningFamilyMarkers {
		if strings.Contains(id, m) {
			return true
		}
	}
	return false
}

func hasVerifiedImageInput(kiroModelID string) bool {
	return strings.HasPrefix(kiroModelID, "claude-") || verifiedImageModelIDs[strings.ToLower(kiroModelID)]
}

func stringValues(list []string) []jsjson.Value {
	out := make([]jsjson.Value, len(list))
	for i, s := range list {
		out[i] = s
	}
	return out
}

// mapCatalogModels is mapKiroCatalogModels.
func mapCatalogModels(catalog []jsjson.Value, region string, rates map[string]modelRate, known []knownModel) ([]jsjson.Value, error) {
	if len(catalog) == 0 {
		return nil, fmt.Errorf("Kiro management catalog returned no models in %s", region)
	}
	seen := map[string]bool{}
	out := make([]jsjson.Value, 0, len(catalog))
	for _, raw := range catalog {
		cm := raw.(*jsjson.Object)
		idv, _ := cm.Get("modelId")
		kiroModelID, _ := idv.(string)
		if kiroModelID == "" || jsstr.Trim(kiroModelID) != kiroModelID {
			return nil, fmt.Errorf("Kiro management catalog returned an invalid model ID in %s", region)
		}
		id := dottedVersionPattern.ReplaceAllString(kiroModelID, "$1-$2")
		if seen[id] {
			return nil, fmt.Errorf("Kiro management catalog contains conflicting model ID %s in %s", id, region)
		}
		seen[id] = true

		var existing *knownModel
		for i := range known {
			if known[i].ID == id {
				existing = &known[i]
				break
			}
		}
		rate, hasRate := rates[kiroModelID]

		schema, _ := cm.Get("additionalModelRequestFieldsSchema")
		if schema != nil && !isRecord(schema) {
			return nil, fmt.Errorf("Kiro management catalog model %s has an invalid request-fields schema", kiroModelID)
		}
		tokenLimitsV, hasLimits := cm.Get("tokenLimits")
		var tokenLimits *jsjson.Object
		if hasLimits {
			tl, ok := tokenLimitsV.(*jsjson.Object)
			if !ok {
				return nil, fmt.Errorf("Kiro management catalog model %s has invalid token limits", kiroModelID)
			}
			for _, k := range []string{"maxInputTokens", "maxOutputTokens"} {
				if v, has := tl.Get(k); has && !isPositive(v) {
					return nil, fmt.Errorf("Kiro management catalog model %s has invalid token limits", kiroModelID)
				}
			}
			tokenLimits = tl
		}

		var cfg *effortConfig
		if schema != nil {
			cfg = deriveEffort(schema)
		} else {
			cfg = fallbackEffort(kiroModelID)
		}
		name := ""
		if dn, _ := cm.Get("displayName"); dn != nil {
			if s, ok := dn.(string); ok {
				name = s
			}
		}
		if name == "" && existing != nil {
			name = existing.Name
		}
		if name == "" {
			name = humanizeModelID(kiroModelID)
		}

		m := jsjson.NewObject()
		m.Set("id", id)
		m.Set("kiroModelId", kiroModelID)
		m.Set("name", name)
		m.Set("region", region)
		m.Set("reasoning", (schema != nil && cfg != nil) || (schema == nil && hasReasoningFamilyFallback(id)))
		if cfg != nil && len(cfg.values) > 0 {
			var efforts []string
			for _, e := range effortOrder {
				if contains(cfg.values, e) {
					efforts = append(efforts, e)
				}
			}
			if len(efforts) > 0 {
				m.Set("efforts", stringValues(efforts))
				if cfg.summarizedThinking {
					m.Set("supportsSummarizedThinking", true)
				}
			}
		}
		switch {
		case existing != nil:
			m.Set("input", stringValues(existing.Input))
		case hasVerifiedImageInput(kiroModelID):
			m.Set("input", stringValues([]string{"text", "image"}))
		default:
			m.Set("input", stringValues([]string{"text"}))
		}
		if strings.HasPrefix(id, "claude-") {
			m.Set("recoverTextToolCalls", false)
		}
		cost := jsjson.NewObject()
		for _, k := range []string{"input", "output", "cacheRead", "cacheWrite"} {
			cost.Set(k, float64(0))
		}
		m.Set("cost", cost)
		if hasRate {
			m.Set("rateMultiplier", rate.multiplier)
			if rate.unit != "" {
				m.Set("rateUnit", rate.unit)
			}
		}
		contextWindow, maxTokens := jsjson.Value(float64(defaultContextWindow)), jsjson.Value(float64(defaultMaxTokens))
		if tokenLimits != nil {
			if v, _ := tokenLimits.Get("maxInputTokens"); v != nil {
				contextWindow = v
			}
			if v, _ := tokenLimits.Get("maxOutputTokens"); v != nil {
				maxTokens = v
			}
		}
		m.Set("contextWindow", contextWindow)
		m.Set("maxTokens", maxTokens)
		if existing != nil && existing.FirstTokenTimeout != 0 {
			m.Set("firstTokenTimeout", existing.FirstTokenTimeout)
		}
		if schema != nil {
			m.Set("additionalModelRequestFieldsSchema", schema)
		}
		if tokenLimits != nil {
			m.Set("tokenLimits", tokenLimits)
		}
		out = append(out, m)
	}
	return out, nil
}

func isEffortList(v jsjson.Value) bool {
	list, ok := v.([]jsjson.Value)
	if !ok || len(list) == 0 {
		return false
	}
	for _, e := range list {
		s, ok := e.(string)
		if !ok || effortRank(s) < 0 {
			return false
		}
	}
	return true
}

func isCachedModel(v jsjson.Value) bool {
	m, ok := v.(*jsjson.Object)
	if !ok {
		return false
	}
	get := func(k string) jsjson.Value { x, _ := m.Get(k); return x }
	nonEmpty := func(k string) bool { s, ok := get(k).(string); return ok && s != "" }
	if !nonEmpty("id") || !nonEmpty("kiroModelId") || !nonEmpty("name") {
		return false
	}
	if _, ok := get("reasoning").(bool); !ok {
		return false
	}
	input, ok := get("input").([]jsjson.Value)
	if !ok || len(input) == 0 {
		return false
	}
	for _, x := range input {
		if x != "text" && x != "image" {
			return false
		}
	}
	cost, ok := get("cost").(*jsjson.Object)
	if !ok {
		return false
	}
	for _, k := range []string{"input", "output", "cacheRead", "cacheWrite"} {
		if x, _ := cost.Get(k); func() bool { _, ok := x.(float64); return !ok }() {
			return false
		}
	}
	if !isPositive(get("contextWindow")) || !isPositive(get("maxTokens")) {
		return false
	}
	optional := func(k string, valid func(jsjson.Value) bool) bool {
		x, has := m.Get(k)
		return !has || valid(x)
	}
	return optional("efforts", isEffortList) &&
		optional("effortMap", func(x jsjson.Value) bool {
			o, ok := x.(*jsjson.Object)
			if !ok {
				return false
			}
			for _, k := range o.Keys() {
				if v, _ := o.Get(k); func() bool { _, ok := v.(string); return !ok }() {
					return false
				}
			}
			return true
		}) &&
		optional("additionalModelRequestFieldsSchema", isRecord) &&
		optional("tokenLimits", isRecord) &&
		optional("firstTokenTimeout", isPositive) &&
		optional("rateMultiplier", isPositive) &&
		optional("rateUnit", func(x jsjson.Value) bool { _, ok := x.(string); return ok })
}

// readManagementCache is readManagementCache: nil when absent or invalid.
func readManagementCache(path string) *jsjson.Object {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	v, err := jsjson.Parse(raw)
	if err != nil {
		return nil
	}
	obj, ok := v.(*jsjson.Object)
	if !ok {
		return nil
	}
	version, _ := obj.Get("version")
	source, _ := obj.Get("source")
	regionsV, _ := obj.Get("regions")
	regions, ok := regionsV.(*jsjson.Object)
	if version != float64(cacheVersion) || source != cacheSource || !ok {
		return nil
	}
	clean := jsjson.NewObject()
	for _, region := range regions.Keys() {
		entryV, _ := regions.Get(region)
		entry, ok := entryV.(*jsjson.Object)
		if !ok {
			return nil
		}
		r, _ := entry.Get("region")
		fetchedAt, _ := entry.Get("fetchedAt")
		modelsV, _ := entry.Get("models")
		models, ok := modelsV.([]jsjson.Value)
		if r != region || !isPositive(fetchedAt) || !ok || len(models) == 0 {
			return nil
		}
		ids := map[string]bool{}
		for _, m := range models {
			if !isCachedModel(m) {
				return nil
			}
			id, _ := m.(*jsjson.Object).Get("id")
			if ids[id.(string)] {
				return nil
			}
			ids[id.(string)] = true
		}
		clean.Set(region, entry)
	}
	out := jsjson.NewObject()
	out.Set("version", float64(cacheVersion))
	out.Set("source", cacheSource)
	out.Set("regions", clean)
	return out
}

// writeManagementCache writes JSON.stringify(cache, null, 2) atomically.
func writeManagementCache(path string, cache *jsjson.Object) error {
	tmp := fmt.Sprintf("%s.%d.%s.tmp", path, os.Getpid(), newUUID())
	defer os.Remove(tmp)
	if err := os.WriteFile(tmp, []byte(jsjson.StringifyIndent(cache, "  ")), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ---------------------------------------------------------------- usage

type kiroCredentials struct {
	Access       string  `json:"access"`
	Refresh      string  `json:"refresh"`
	Expires      float64 `json:"expires"`
	ClientID     string  `json:"clientId"`
	ClientSecret string  `json:"clientSecret"`
	Region       string  `json:"region"`
	AuthMethod   string  `json:"authMethod"`
	ProfileArn   string  `json:"profileArn,omitempty"`
	StartURL     string  `json:"startUrl,omitempty"`
	IsEnterprise *bool   `json:"isEnterprise,omitempty"`
	raw          *jsjson.Object
}

type credentialsRequest struct {
	opState
	Credentials json.RawMessage `json:"credentials"`
}

func (r *credentialsRequest) credentials() (*kiroCredentials, error) {
	var c kiroCredentials
	if err := json.Unmarshal(r.Credentials, &c); err != nil {
		return nil, fmt.Errorf("kiro credentials: %v", err)
	}
	if v, err := jsjson.Parse(r.Credentials); err == nil {
		c.raw, _ = v.(*jsjson.Object)
	}
	return &c, nil
}

const manageUsageURL = "https://app.kiro.dev/account/usage"

func fetchUsage(ctx context.Context, raw json.RawMessage) (any, error) {
	var req credentialsRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, fmt.Errorf("kiro usage request: %v", err)
	}
	creds, err := req.credentials()
	if err != nil {
		return nil, err
	}
	s := req.session()
	auth := managementAuth{creds.Access, resolveAPIRegion(creds.Region)}
	profileArn, err := s.resolveProfile(ctx, auth, creds.ProfileArn)
	if err != nil {
		return nil, err
	}

	const op = "GetUsageLimits"
	q := "profileArn=" + url.QueryEscape(profileArn) + "&origin=KIRO_CLI&resourceType=CREDIT&isEmailRequired=false"
	u := resolveURL("Get-Usage-Limits", managementBase(auth.region)) + "?" + q
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Accept", "application/json")
	authHeaders(httpReq.Header, auth.accessToken, true)
	httpReq.Header.Set("User-Agent", "ns-kiro-provider")
	resp, err := s.client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("Kiro management %s request failed in %s", op, auth.region)
	}
	var body json.RawMessage
	if err := parseManagementResponse(resp, op, auth.region, &body); err != nil {
		return nil, err
	}
	parsed, err := jsjson.Parse(body)
	if err != nil {
		return nil, fmt.Errorf("Kiro management %s returned invalid JSON in %s", op, auth.region)
	}
	rawObj, _ := parsed.(*jsjson.Object)
	if rawObj == nil {
		rawObj = jsjson.NewObject()
	}
	get := func(o *jsjson.Object, path ...string) jsjson.Value {
		var cur jsjson.Value = o
		for _, k := range path {
			obj, ok := cur.(*jsjson.Object)
			if !ok {
				return nil
			}
			cur, _ = obj.Get(k)
		}
		return cur
	}

	var buckets []jsjson.Value
	if list, ok := get(rawObj, "usageBreakdownList").([]jsjson.Value); ok && len(list) > 0 {
		for i, b := range list {
			buckets = append(buckets, mapUsageBucket(b, i))
		}
	} else if b := get(rawObj, "usageBreakdown"); jsTruthy(b) {
		buckets = append(buckets, mapUsageBucket(b, 0))
	}
	if buckets == nil {
		buckets = []jsjson.Value{}
	}

	out := jsjson.NewObject()
	setIf := func(k string, v jsjson.Value) {
		if v != nil {
			out.Set(k, v)
		}
	}
	setIf("summary", get(rawObj, "subscriptionInfo", "subscriptionTitle"))
	setIf("subscriptionTitle", get(rawObj, "subscriptionInfo", "subscriptionTitle"))
	setIf("resetAt", toISODate(get(rawObj, "nextDateReset")))
	setIf("daysUntilReset", get(rawObj, "daysUntilReset"))
	setIf("overageStatus", get(rawObj, "overageConfiguration", "overageStatus"))
	out.Set("manageUrl", manageUsageURL)
	out.Set("usageBuckets", buckets)
	out.Set("raw", rawObj)
	s.profileState(out)
	return out, nil
}

func firstDefined(vs ...jsjson.Value) jsjson.Value {
	for _, v := range vs {
		if v != nil {
			return v
		}
	}
	return nil
}

// toISODate is toIsoDate: epoch seconds or a date string → ISO, else nil.
func toISODate(v jsjson.Value) jsjson.Value {
	var ms float64
	switch t := v.(type) {
	case float64:
		ms = t * 1000
	case string:
		ms = parseDateString(t)
	default:
		return nil
	}
	if math.IsNaN(ms) || math.IsInf(ms, 0) || math.Abs(ms) > 8.64e15 {
		return nil
	}
	return time.UnixMilli(int64(math.Trunc(ms))).UTC().Format("2006-01-02T15:04:05.000Z")
}

func parseDateString(s string) float64 {
	s = strings.TrimSpace(s)
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02T15:04", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return float64(t.UnixMilli())
		}
	}
	return math.NaN()
}

// formatCount is formatCount.
func formatCount(v jsjson.Value) jsjson.Value {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) {
		return nil
	}
	if f == math.Trunc(f) && !math.IsInf(f, 0) {
		return jsjson.FormatNumber(f)
	}
	return strconv.FormatFloat(f, 'f', 2, 64)
}

func groupThousands(s string) string {
	intPart, frac := s, ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart, frac = s[:i], s[i:]
	}
	var b strings.Builder
	for i, c := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return b.String() + frac
}

var currencySymbols = map[string]string{"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "INR": "₹", "CAD": "CA$", "AUD": "A$"}
var currencyCodePattern = regexp.MustCompile(`^[A-Za-z]{3}$`)

// formatMoney is formatMoney (Intl.NumberFormat en-US currency).
func formatMoney(amount, currency jsjson.Value) jsjson.Value {
	f, ok := amount.(float64)
	if !ok || math.IsNaN(f) || f <= 0 {
		return nil
	}
	code, _ := currency.(string)
	if code == "" {
		code = "USD"
	}
	if !currencyCodePattern.MatchString(code) {
		return strconv.FormatFloat(f, 'f', 2, 64) + " " + code
	}
	upper := strings.ToUpper(code)
	digits := 2
	if upper == "JPY" {
		digits = 0
	}
	number := groupThousands(strconv.FormatFloat(f, 'f', digits, 64))
	if sym, ok := currencySymbols[upper]; ok {
		return sym + number
	}
	return upper + "\u00a0" + number
}

func mapUsageBucket(v jsjson.Value, index int) jsjson.Value {
	b, _ := v.(*jsjson.Object)
	if b == nil {
		b = jsjson.NewObject()
	}
	get := func(o *jsjson.Object, k string) jsjson.Value {
		if o == nil {
			return nil
		}
		x, _ := o.Get(k)
		return x
	}
	str := func(k string) string { s, _ := get(b, k).(string); return s }
	trial, _ := get(b, "freeTrialInfo").(*jsjson.Object)

	used := firstDefined(get(b, "currentUsageWithPrecision"), get(b, "currentUsage"))
	limit := firstDefined(get(b, "usageLimitWithPrecision"), get(b, "usageLimit"))
	overages := firstDefined(get(b, "currentOveragesWithPrecision"), get(b, "currentOverages"))
	trialUsed := firstDefined(get(trial, "currentUsageWithPrecision"), get(trial, "currentUsage"))
	trialLimit := firstDefined(get(trial, "usageLimitWithPrecision"), get(trial, "usageLimit"))

	id := str("resourceType")
	if id == "" {
		id = str("displayName")
	}
	if id == "" {
		id = fmt.Sprintf("usage-%d", index)
	}
	label := str("displayName")
	for _, k := range []string{"displayNamePlural", "resourceType"} {
		if label == "" {
			label = str(k)
		}
	}
	if label == "" {
		label = "Usage"
	}
	positive := func(x jsjson.Value) bool { f, ok := x.(float64); return ok && f > 0 }

	out := jsjson.NewObject()
	setIf := func(k string, x jsjson.Value) {
		if x != nil {
			out.Set(k, x)
		}
	}
	out.Set("id", id)
	out.Set("label", label)
	setIf("resourceType", get(b, "resourceType"))
	out.Set("used", firstDefined(used, float64(0)))
	setIf("limit", limit)
	if positive(overages) {
		out.Set("overages", overages)
	}
	if d := formatCount(used); d != nil {
		out.Set("usedDisplay", d)
	} else {
		out.Set("usedDisplay", "0")
	}
	setIf("limitDisplay", formatCount(limit))
	setIf("unit", get(b, "unit"))
	if positive(overages) {
		setIf("overagesDisplay", formatCount(overages))
	}
	setIf("overageChargesDisplay", formatMoney(get(b, "overageCharges"), get(b, "currency")))
	setIf("resetAt", toISODate(get(b, "nextDateReset")))
	if trialUsed != nil || trialLimit != nil || get(trial, "freeTrialExpiry") != nil {
		bonus := jsjson.NewObject()
		bonus.Set("label", "Bonus credits")
		if d := formatCount(trialUsed); d != nil {
			bonus.Set("usedDisplay", d)
		}
		if d := formatCount(trialLimit); d != nil {
			bonus.Set("limitDisplay", d)
		}
		if d := toISODate(get(trial, "freeTrialExpiry")); d != nil {
			bonus.Set("expiresAt", d)
		}
		out.Set("bonus", bonus)
	}
	return out
}

// ---------------------------------------------------------------- token refresh

const (
	expiresBufferMs       = 5 * 60 * 1000
	kiroDesktopUserAgent  = "Kiro-Desktop/0.2.13 (darwin; arm64)"
	EnvDesktopRefreshURL  = "KIRO_DESKTOP_REFRESH_ENDPOINT"
	EnvOIDCEndpoint       = "KIRO_OIDC_ENDPOINT"
	defaultDesktopRefresh = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken"
	defaultOIDCEndpoint   = "https://oidc.{region}.amazonaws.com"
)

func envEndpoint(name, fallback, region string) string {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		v = fallback
	}
	return strings.ReplaceAll(v, "{region}", region)
}

func (s *session) postJSON(ctx context.Context, u string, headers map[string]string, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, errors.New("fetch failed")
	}
	return resp, nil
}

func readJSON(resp *http.Response) (*jsjson.Object, error) {
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	v, err := jsjson.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("Unexpected token in JSON: %v", err)
	}
	obj, _ := v.(*jsjson.Object)
	if obj == nil {
		obj = jsjson.NewObject()
	}
	return obj, nil
}

func objStr(o *jsjson.Object, k string) string {
	v, _ := o.Get(k)
	s, _ := v.(string)
	return s
}

// jsTemplate is `${v}` for a JSON value.
func jsTemplate(v jsjson.Value) string {
	switch t := v.(type) {
	case nil:
		return "undefined"
	case string:
		return t
	case float64:
		return jsjson.FormatNumber(t)
	case bool:
		return strconv.FormatBool(t)
	default:
		return jsjson.Stringify(t)
	}
}

func expiresIn(o *jsjson.Object, k string, fallback *float64) float64 {
	v, _ := o.Get(k)
	if f, ok := v.(float64); ok {
		return nowMs() + f*1000 - expiresBufferMs
	}
	if fallback != nil {
		return nowMs() + *fallback*1000 - expiresBufferMs
	}
	return math.NaN()
}

// refreshToken is refreshKiroTokenDirect: the network half of a refresh
// (which store to trust and where to save stays with the caller).
func refreshToken(ctx context.Context, raw json.RawMessage) (any, error) {
	var req credentialsRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, fmt.Errorf("kiro refreshToken request: %v", err)
	}
	c, err := req.credentials()
	if err != nil {
		return nil, err
	}
	s := req.session()
	parts := strings.Split(c.Refresh, "|")
	refresh := parts[0]
	authMethod := parts[len(parts)-1]
	region := c.Region
	if region == "" {
		region = "us-east-1"
	}
	part := func(i int) string {
		if i < len(parts) {
			return parts[i]
		}
		return ""
	}
	setOpt := func(o *jsjson.Object, k string) {
		if c.raw == nil {
			return
		}
		if v, ok := c.raw.Get(k); ok && v != nil {
			o.Set(k, v)
		}
	}

	switch authMethod {
	case "apikey":
		return c.raw, nil
	case "desktop":
		body, _ := json.Marshal(map[string]string{"refreshToken": refresh})
		resp, err := s.postJSON(ctx, envEndpoint(EnvDesktopRefreshURL, defaultDesktopRefresh, region),
			map[string]string{"Content-Type": "application/json", "User-Agent": kiroDesktopUserAgent}, body)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			resp.Body.Close()
			return nil, fmt.Errorf("Desktop token refresh failed: %d", resp.StatusCode)
		}
		data, err := readJSON(resp)
		if err != nil {
			return nil, err
		}
		if objStr(data, "accessToken") == "" {
			return nil, errors.New("Desktop token refresh: missing accessToken")
		}
		nextRefresh := objStr(data, "refreshToken")
		if nextRefresh == "" {
			nextRefresh = refresh
		}
		out := jsjson.NewObject()
		out.Set("refresh", nextRefresh+"|desktop")
		out.Set("access", objStr(data, "accessToken"))
		out.Set("expires", expiresIn(data, "expiresIn", nil))
		out.Set("clientId", "")
		out.Set("clientSecret", "")
		out.Set("region", region)
		out.Set("authMethod", "desktop")
		if arn := objStr(data, "profileArn"); arn != "" {
			out.Set("profileArn", arn)
		} else {
			setOpt(out, "profileArn")
		}
		setOpt(out, "startUrl")
		return out, nil
	case "external-idp":
		clientID, tokenEndpoint := part(1), part(2)
		if tokenEndpoint == "" {
			return nil, errors.New("External IdP token refresh: missing token endpoint")
		}
		body := "grant_type=refresh_token&client_id=" + url.QueryEscape(clientID) + "&refresh_token=" + url.QueryEscape(refresh)
		resp, err := s.postJSON(ctx, tokenEndpoint, map[string]string{
			"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "User-Agent": "kiro-core",
		}, []byte(body))
		if err != nil {
			return nil, err
		}
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			resp.Body.Close()
			return nil, fmt.Errorf("External IdP token refresh failed: %d", resp.StatusCode)
		}
		data, err := readJSON(resp)
		if err != nil {
			return nil, err
		}
		if objStr(data, "access_token") == "" {
			return nil, errors.New("External IdP token refresh: missing access_token")
		}
		nextRefresh := objStr(data, "refresh_token")
		if nextRefresh == "" {
			nextRefresh = refresh
		}
		hour := 3600.0
		out := jsjson.NewObject()
		out.Set("refresh", nextRefresh+"|"+clientID+"|"+tokenEndpoint+"|external-idp")
		out.Set("access", objStr(data, "access_token"))
		out.Set("expires", expiresIn(data, "expires_in", &hour))
		out.Set("clientId", clientID)
		out.Set("clientSecret", "")
		out.Set("region", region)
		out.Set("authMethod", "external-idp")
		setOpt(out, "profileArn")
		return out, nil
	}

	clientID, clientSecret := part(1), part(2)
	body := jsjson.NewObject()
	body.Set("clientId", clientID)
	body.Set("clientSecret", clientSecret)
	body.Set("refreshToken", refresh)
	body.Set("grantType", "refresh_token")
	headers := http.Header{}
	userAgentHeaders(headers, "ssooidc", "E")
	hs := map[string]string{"Content-Type": "application/json"}
	for k := range headers {
		hs[k] = headers.Get(k)
	}
	resp, err := s.postJSON(ctx, envEndpoint(EnvOIDCEndpoint, defaultOIDCEndpoint, region)+"/token", hs, []byte(jsjson.Stringify(body)))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		resp.Body.Close()
		return nil, fmt.Errorf("Token refresh failed: %d", resp.StatusCode)
	}
	data, err := readJSON(resp)
	if err != nil {
		return nil, err
	}
	next, _ := data.Get("refreshToken")
	access, _ := data.Get("accessToken")
	out := jsjson.NewObject()
	out.Set("refresh", jsTemplate(next)+"|"+clientID+"|"+clientSecret+"|idc")
	if access != nil {
		out.Set("access", access)
	}
	out.Set("expires", expiresIn(data, "expiresIn", nil))
	out.Set("clientId", clientID)
	out.Set("clientSecret", clientSecret)
	out.Set("region", region)
	out.Set("authMethod", "idc")
	setOpt(out, "profileArn")
	setOpt(out, "startUrl")
	setOpt(out, "isEnterprise")
	return out, nil
}
