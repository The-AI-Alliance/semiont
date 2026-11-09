package launcher

// secretscrub.go — the secret values this process has generated or read,
// kept so that no line semiont control sends carries one: a progress line, a
// log record, a diagnostic, an error's message. Each place a value enters the
// launcher notes it — custody's reads and writes, a provider's read, the
// environment's, a generated password, a sign-in's tokens — and scrubSecrets
// removes every one noted.

import (
	"sort"
	"strings"
	"sync"
)

// scrubbedSecret: what a secret value is replaced with.
const scrubbedSecret = "‹secret›"

// shortestScrubbed: a value shorter than this is not scrubbed. Replacing a
// few characters wherever they appear would mangle ordinary text, and every
// value the launcher generates is far longer.
const shortestScrubbed = 8

var noted struct {
	mu     sync.Mutex
	values map[string]bool
	// longestFirst: values in the order they are replaced, so a value that
	// contains another is replaced whole.
	longestFirst []string
}

// noteSecret records value as a secret this process holds.
func noteSecret(value string) {
	if len(value) < shortestScrubbed {
		return
	}
	noted.mu.Lock()
	defer noted.mu.Unlock()
	if noted.values[value] {
		return
	}
	if noted.values == nil {
		noted.values = map[string]bool{}
	}
	noted.values[value] = true
	noted.longestFirst = append(noted.longestFirst, value)
	sort.Slice(noted.longestFirst, func(i, j int) bool { return len(noted.longestFirst[i]) > len(noted.longestFirst[j]) })
}

// scrubSecrets: line, with each secret value noted replaced.
func scrubSecrets(line string) string {
	noted.mu.Lock()
	defer noted.mu.Unlock()
	for _, v := range noted.longestFirst {
		line = strings.ReplaceAll(line, v, scrubbedSecret)
	}
	return line
}
