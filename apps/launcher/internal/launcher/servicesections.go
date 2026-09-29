package launcher

import "sort"

// serviceConfigSections: the [environments.<env>] sections each Node service
// reads — the launcher forwards a service only the variables those sections
// reference (SECRET-DELIVERY P5). The authority is
// specs/src/service-config/sections.json, which the TypeScript loader
// enforces; TestServiceSectionsAgreeWithTheSpec holds this copy to it.
var serviceConfigSections = map[string][]string{
	"archivist":  {"gateway", "graph", "vectors", "embedding", "identity", "make-meaning", "actors", "workers", "inference"},
	"librarian":  {"gateway", "graph", "vectors", "embedding", "identity", "archivist", "make-meaning", "actors", "inference"},
	"dispatcher": {"gateway", "jobs", "identity"},
	"weaver":     {"gateway", "graph", "identity"},
	"smelter":    {"gateway", "vectors", "embedding", "identity", "archivist"},
	"worker":     {"gateway", "identity", "archivist", "workers", "inference"},
}

// serviceVars: for each stack service, the user variables it is handed — the
// references in the selected environment's sections it reads, minus the ones
// the launcher injects. The gateway reads no KB config: its variables are the
// ones its document names.
func serviceVars(doc any, envName string, env *envConfig) map[string][]string {
	out := map[string][]string{"gateway": gatewayNamedVars(env)}
	var envSection map[string]any
	if root, ok := doc.(map[string]any); ok {
		if envs, ok := root["environments"].(map[string]any); ok {
			envSection, _ = envs[envName].(map[string]any)
		}
	}
	for svc, sections := range serviceConfigSections {
		seen := map[string]bool{}
		var names []string
		var walk func(v any)
		walk = func(v any) {
			switch t := v.(type) {
			case string:
				required, optional := placeholderRefs(t)
				for _, name := range append(required, optional...) {
					if !seen[name] && !injectedVars[name] {
						seen[name] = true
						names = append(names, name)
					}
				}
			case map[string]any:
				for _, vv := range t {
					walk(vv)
				}
			case []any:
				for _, vv := range t {
					walk(vv)
				}
			}
		}
		for _, sec := range sections {
			walk(envSection[sec])
			if sec == "gateway" {
				walk(envSection["backend"]) // its legacy spelling
			}
		}
		sort.Strings(names)
		out[svc] = names
	}
	return out
}
