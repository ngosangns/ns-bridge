// Package httpx holds the HTTP client every Go vendor core shares, set up to
// behave like the Node fetch the TypeScript cores used: HTTP/1.1 only, and an
// environment proxy only when Node would honour one (NODE_USE_ENV_PROXY=1).
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
		client = &http.Client{Transport: transport}
	})
	return client
}
