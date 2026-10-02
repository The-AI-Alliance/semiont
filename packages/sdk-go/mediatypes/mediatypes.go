// Package mediatypes reads the media-type registry
// (specs/src/media-types/registry.json): the types a knowledge base admits.
// The table is generated (registry_gen.go); the rules read from it are here.
package mediatypes

import "strings"

// byExtension: each extension a row states, with the first row that states it.
var byExtension = func() map[string]string {
	m := make(map[string]string, len(Rows))
	for _, row := range Rows {
		if _, stated := m[row.Extension]; !stated {
			m[row.Extension] = row.MediaType
		}
	}
	return m
}()

// ForExtension is the media type a file's extension names, and false for an
// extension no row states: a caller chooses its own fallback. It takes "md" or
// ".md" in any case, and the registry's aliases (".markdown", ".yml").
func ForExtension(ext string) (string, bool) {
	ext = strings.ToLower(strings.TrimSpace(ext))
	if !strings.HasPrefix(ext, ".") {
		ext = "." + ext
	}
	if stated, ok := ExtensionAliases[ext]; ok {
		ext = stated
	}
	mediaType, ok := byExtension[ext]
	return mediaType, ok
}
