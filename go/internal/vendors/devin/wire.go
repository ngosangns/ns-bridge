package devin

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"runtime"
	"strings"
	"unicode/utf8"
)

// DefaultBaseURL is Devin's Cascade chat API (Connect over HTTP/1.1).
const DefaultBaseURL = "https://server.codeium.com"

// SessionTokenPrefix is the scheme a Devin session token carries on the wire.
const SessionTokenPrefix = "devin-session-token$"

// Paths of the Connect RPCs a turn uses.
const (
	authPath        = "/exa.auth_pb.AuthService/GetUserJwt"
	assignModelPath = "/exa.api_server_pb.ApiServerService/AssignModel"
	chatMessagePath = "/exa.api_server_pb.ApiServerService/GetChatMessage"
	cliModelsPath   = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs"
	userStatusPath  = "/exa.seat_management_pb.SeatManagementService/GetUserStatus"
)

func devinOS() string {
	switch runtime.GOOS {
	case "darwin":
		return "darwin"
	case "windows":
		return "windows"
	default:
		return "linux"
	}
}

// NormalizeSessionToken adds the scheme prefix the wire requires.
func NormalizeSessionToken(apiKey string) string {
	if apiKey == "" {
		return ""
	}
	if strings.HasPrefix(apiKey, SessionTokenPrefix) {
		return apiKey
	}
	return SessionTokenPrefix + apiKey
}

// wireMetadata is the released Devin CLI identity; `ideType: chisel` is what
// unlocks router assignment and the CLI model surface.
func wireMetadata(apiKey, userJwt string) Metadata {
	return Metadata{
		APIKey:           apiKey,
		UserJwt:          userJwt,
		IdeName:          "devin-cli",
		IdeType:          "chisel",
		IdeVersion:       "3000.11.3",
		ExtensionName:    "chisel",
		ExtensionVersion: "3000.11.3",
		Locale:           "en",
		OS:               devinOS(),
	}
}

func cliMetadata(apiKey, userJwt string) Metadata {
	return wireMetadata(NormalizeSessionToken(apiKey), userJwt)
}

// discoveryMetadata is the dev-channel identity GetCliModelConfigs wants.
func discoveryMetadata(apiKey string) Metadata {
	return Metadata{
		APIKey:           NormalizeSessionToken(apiKey),
		IdeName:          "chisel",
		IdeVersion:       "0.0.0-dev",
		ExtensionName:    "chisel",
		ExtensionVersion: "0.0.0-dev",
		Locale:           "en",
		OS:               devinOS(),
	}
}

// deterministicUUID formats the leading 128 bits of sha256(seed) as a UUID.
func deterministicUUID(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	h := hex.EncodeToString(sum[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

var sensitivePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(sk|pk|key|token|secret|password|bearer|api[_-]?key|credential|authorization)\s*[:=]\s*["']?[\w.$~+-]{6,}["']?`),
	regexp.MustCompile(`\b(cog_|devin-session-token\$)[\w.$~+-]+`),
	regexp.MustCompile(`(?i)\bBearer\s+[\w.$~+-]{6,}`),
}

var separatorPattern = regexp.MustCompile(`[:=\s]`)

// RedactSensitiveCredentials blanks credential-looking tokens.
func RedactSensitiveCredentials(text string) string {
	out := text
	for _, p := range sensitivePatterns {
		out = p.ReplaceAllStringFunc(out, func(match string) string {
			sep := 0
			if loc := separatorPattern.FindStringIndex(match); loc != nil {
				sep = loc[0]
			}
			return match[:sep+1] + "[REDACTED]"
		})
	}
	return out
}

// normalizeSystemPrompts flattens the request's systemPrompt (string or
// string[]) into the non-empty, credential-scrubbed list Cascade wants.
func normalizeSystemPrompts(prompts []string) []string {
	var out []string
	for _, p := range prompts {
		p = RedactSensitiveCredentials(strings.ToValidUTF8(p, "\uFFFD"))
		if strings.TrimSpace(p) != "" {
			out = append(out, p)
		}
	}
	return out
}

var (
	ansiPattern    = regexp.MustCompile("\x1b(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^\x07\x1b]*(?:\x07|\x1b\\\\)|[@-Z\\\\-_])")
	controlPattern = regexp.MustCompile("[\x00-\x08\x0B-\x1F\x7F-\u009F]")
)

// isCleanText reports whether sanitizeText would leave text unchanged.
func isCleanText(text string) bool {
	return utf8.ValidString(text) && !ansiPattern.MatchString(text) && !controlPattern.MatchString(text)
}
