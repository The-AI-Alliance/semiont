package launcher

import (
	"fmt"
	"strings"
)

// personDID: the DID a person acts under — did:web:<domain>:users:<subject>,
// the subject percent-encoded as ECMAScript's encodeURIComponent does. The
// rule is specs/src/principals/cases.json's, which @semiont/core and the Rust
// gateway also run (TestPersonDIDAgreesWithTheSpec).
func personDID(domain, subject string) string {
	return "did:web:" + domain + ":users:" + encodeURIComponent(subject)
}

// encodeURIComponent: every UTF-8 byte of a character other than A–Z a–z 0–9
// - _ . ! ~ * ' ( ) as %XX in uppercase hex.
func encodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}
