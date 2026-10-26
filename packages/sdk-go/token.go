package semiont

// How a token is held: what its claims say, when it expires, and when it is
// renewed (specs/src/session/cases.json, refreshSchedule and tokenExpiry).
// Nothing here checks a signature: a client reads a token it was given only to
// know when to renew it and whom it names.

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

// tokenClaims is the claims of a JWT: its second segment of three, base64url
// without padding, UTF-8 JSON naming an object.
func tokenClaims(token string) (map[string]json.RawMessage, bool) {
	segments := strings.Split(token, ".")
	if len(segments) != 3 {
		return nil, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil {
		return nil, false
	}
	var claims map[string]json.RawMessage
	if json.Unmarshal(payload, &claims) != nil || claims == nil {
		return nil, false
	}
	return claims, true
}

// secondsClaim is a numeric claim, in seconds since the epoch. Absent, zero,
// or not a number is none.
func secondsClaim(claims map[string]json.RawMessage, name string) (float64, bool) {
	var seconds float64
	if raw, ok := claims[name]; !ok || json.Unmarshal(raw, &seconds) != nil || seconds == 0 {
		return 0, false
	}
	return seconds, true
}

// textClaim is a claim of token that is text, when it carries one.
func textClaim(token, name string) (string, bool) {
	claims, ok := tokenClaims(token)
	if !ok {
		return "", false
	}
	var text string
	if raw, ok := claims[name]; !ok || json.Unmarshal(raw, &text) != nil {
		return "", false
	}
	return text, true
}

func atSeconds(seconds float64) time.Time {
	return time.Unix(0, int64(seconds*float64(time.Second)))
}

// tokenExpiry is when token expires, by its exp claim; false when it names no
// time.
func tokenExpiry(token string) (time.Time, bool) {
	claims, ok := tokenClaims(token)
	if !ok {
		return time.Time{}, false
	}
	expiry, ok := secondsClaim(claims, "exp")
	if !ok {
		return time.Time{}, false
	}
	return atSeconds(expiry), true
}

// isTokenExpired reports whether token is past its expiry at now. One that
// names no expiry is read as expired: nothing says it is still good.
func isTokenExpired(token string, now time.Time) bool {
	expiry, ok := tokenExpiry(token)
	return !ok || expiry.Before(now)
}

// renewalDelay is how long to wait before renewing a token that lives
// lifetime in all and has remaining of it left: the margin before expiry is
// half its lifetime, at most timing.RefreshBeforeExp, and the wait is never
// under timing.MinRefreshDelay.
func renewalDelay(lifetime, remaining time.Duration, timing Timing) time.Duration {
	margin := min(timing.RefreshBeforeExp, lifetime/2)
	return max(remaining-margin, timing.MinRefreshDelay)
}

// refreshDelay is how long to wait, from now, before renewing token; false
// when it has no readable exp, and nothing is scheduled. The lifetime is the
// one the issuer chose (exp - iat), or with no iat, what remains of it.
func refreshDelay(token string, now time.Time, timing Timing) (time.Duration, bool) {
	claims, ok := tokenClaims(token)
	if !ok {
		return 0, false
	}
	expiry, ok := secondsClaim(claims, "exp")
	if !ok {
		return 0, false
	}
	remaining := max(atSeconds(expiry).Sub(now), 0)
	lifetime := remaining
	if issued, ok := secondsClaim(claims, "iat"); ok {
		lifetime = max(atSeconds(expiry).Sub(atSeconds(issued)), 0)
	}
	return renewalDelay(lifetime, remaining, timing), true
}
