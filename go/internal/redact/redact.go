// Package redact strips credentials from text before it reaches a log or an
// error message, mirroring the TypeScript cores' redactors.
package redact

import (
	"regexp"

	"github.com/ngosangns/ns-bridge/go/internal/jsstr"
)

const s = "[" + jsstr.SpaceClass + "]"

var (
	kiroQuotedSecret   = regexp.MustCompile(`(?i)(["'](?:access|refresh|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']` + s + `*:` + s + `*["'])[^"']*(["'])`)
	kiroAssignedSecret = regexp.MustCompile(`(?i)(\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret)` + s + `*=` + s + `*)[^` + jsstr.SpaceClass + `,;&]+`)
	kiroBearer         = regexp.MustCompile(`(?i)(\bBearer` + s + `+)[^` + jsstr.SpaceClass + `"',}\]]+`)
	kiroProfileArn     = regexp.MustCompile(`(?i)arn:[a-z0-9-]+:codewhisperer:[^:` + jsstr.SpaceClass + `"']*:[^:` + jsstr.SpaceClass + `"']*:profile/[^` + jsstr.SpaceClass + `"',}\]]+`)
)

// Kiro is ns-kiro-core's redactSensitiveText.
func Kiro(v string) string {
	v = kiroQuotedSecret.ReplaceAllString(v, "${1}<redacted>${2}")
	v = kiroAssignedSecret.ReplaceAllString(v, "${1}<redacted>")
	v = kiroBearer.ReplaceAllString(v, "${1}<redacted>")
	return kiroProfileArn.ReplaceAllString(v, "<redacted-profile-arn>")
}
