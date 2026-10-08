// Package httpx holds the HTTP client every Go vendor core shares, set up to
// behave like the Node fetch the TypeScript cores used: HTTP/1.1 only, Node's
// default headers, and an environment proxy only when Node would honour one
// (NODE_USE_ENV_PROXY=1).
package httpx

import (
	"crypto/tls"
	"net/http"
	"os"
	"sync"
	"time"
)

var (
	once   sync.Once
	client *http.Client
)

// Client returns the shared client. Requests carry their own deadlines via
// context; the client sets none of its own.
func Client() *http.Client {
	once.Do(func() {
		transport := &http.Transport{
			ForceAttemptHTTP2:   false,
			TLSNextProto:        map[string]func(string, *tls.Conn) http.RoundTripper{},
			MaxIdleConnsPerHost: 4,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 30 * time.Second,
		}
		if v := os.Getenv("NODE_USE_ENV_PROXY"); v == "1" || v == "true" {
			transport.Proxy = http.ProxyFromEnvironment
		}
		client = &http.Client{Transport: nodeDefaults{transport}}
	})
	return client
}

// nodeDefaults adds the headers Node's fetch sends when a request does not
// set them, so a vendor sees the same request from either engine.
type nodeDefaults struct{ next http.RoundTripper }

func (t nodeDefaults) RoundTrip(req *http.Request) (*http.Response, error) {
	missing := func(name string) bool { _, ok := req.Header[http.CanonicalHeaderKey(name)]; return !ok }
	if missing("Accept") || missing("User-Agent") || missing("Accept-Language") || missing("Sec-Fetch-Mode") {
		req = req.Clone(req.Context())
		for name, value := range map[string]string{
			"Accept": "*/*", "Accept-Language": "*", "Sec-Fetch-Mode": "cors", "User-Agent": "node",
		} {
			if missing(name) {
				req.Header.Set(name, value)
			}
		}
	}
	return t.next.RoundTrip(req)
}
