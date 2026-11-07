package semiont

// What each live query's cache holds, against
// protocol/specs/src/client/refresh.json: a query's `value`, a component or a
// member within one, is the type of its cache's values, and a persisted
// query's `per` the type of its cache's keys.

import (
	"maps"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// awaitingARuling is the queries whose value the census does not hold yet:
// engines' value waits on a ruling.
var awaitingARuling = map[CacheQuery]bool{CacheQueryEngines: true}

// valueHolders is the types of package api a query's value is a member
// within, found by the component's name: Go finds no type by its name.
var valueHolders = []reflect.Type{
	reflect.TypeFor[api.GetEventsResponse](),
	reflect.TypeFor[api.GetReferencedByResponse](),
	reflect.TypeFor[api.GetEntityTypesResponse](),
	reflect.TypeFor[api.GetTagSchemasResponse](),
	reflect.TypeFor[api.BrowseEnginesResult](),
}

// keptKeys is the type of a persisted query's keys, by what the refresh
// table says it is kept per; absent, the knowledge base has one.
var keptKeys = map[string]reflect.Type{
	"resource":   reflect.TypeFor[api.ResourceId](),
	"annotation": reflect.TypeFor[api.AnnotationId](),
	"":           reflect.TypeFor[whole](),
}

// valueRef is a `value` of the refresh table: the component its `$ref` names,
// and the members within it, outermost first.
type valueRef struct {
	component string
	members   []string
}

// readValueRef is what ref names; false when it is no component, or no
// member within one named member by member.
func readValueRef(ref string) (valueRef, bool) {
	file, fragment, _ := strings.Cut(ref, "#")
	if !strings.HasSuffix(file, ".json") {
		return valueRef{}, false
	}
	read := valueRef{component: strings.TrimSuffix(filepath.Base(file), ".json")}
	if fragment == "" {
		return read, true
	}
	if !strings.HasPrefix(fragment, "/") {
		return valueRef{}, false
	}
	steps := strings.Split(fragment[1:], "/")
	if len(steps)%2 != 0 {
		return valueRef{}, false
	}
	for i := 0; i < len(steps); i += 2 {
		if steps[i] != "properties" || steps[i+1] == "" {
			return valueRef{}, false
		}
		read.members = append(read.members, steps[i+1])
	}
	return read, true
}

// memberType is the type of the member of holder whose JSON name is name;
// false when holder has none.
func memberType(holder reflect.Type, name string) (reflect.Type, bool) {
	if holder.Kind() != reflect.Struct {
		return nil, false
	}
	for i := range holder.NumField() {
		field := holder.Field(i)
		if tagged, _, _ := strings.Cut(field.Tag.Get("json"), ","); tagged == name {
			return field.Type, true
		}
	}
	return nil, false
}

// memberOf is the type of the member within a component that ref names.
func memberOf(t *testing.T, ref valueRef) reflect.Type {
	t.Helper()
	at := slices.IndexFunc(valueHolders, func(holder reflect.Type) bool { return holder.Name() == ref.component })
	if at < 0 {
		t.Fatalf("a value is a member within %s, which this census names no type of package api for", ref.component)
	}
	resolved := valueHolders[at]
	for _, member := range ref.members {
		next, ok := memberType(resolved, member)
		if !ok {
			t.Fatalf("%s has no member %s", resolved, member)
		}
		resolved = next
	}
	return resolved
}

// Every query of the refresh table is a live query of the client's, its
// cache's values of the type the table's `value` names, and a persisted
// query's keys of the type its `per` gives.
func TestEachLiveQuerysCacheHoldsTheValueTheRefreshTableNames(t *testing.T) {
	refresh := readSpec[struct {
		Queries []struct {
			Name      CacheQuery `json:"name"`
			Per       string     `json:"per"`
			Persisted bool       `json:"persisted"`
			Value     struct {
				Ref string `json:"$ref"`
			} `json:"value"`
		} `json:"queries"`
	}](t, "client", "refresh.json")
	var named []CacheQuery
	for _, query := range refresh.Queries {
		named = append(named, query.Name)
	}
	if got, want := slices.Sorted(maps.Keys(queryCaches)), slices.Sorted(slices.Values(named)); len(want) == 0 || !slices.Equal(got, want) {
		t.Fatalf("Go's live queries are %v; the refresh table's are %v", got, want)
	}
	apiPath := reflect.TypeFor[api.ResourceId]().PkgPath()
	// Of a client that holds nothing: only the types of its caches are read.
	unheld := new(live)
	for _, query := range refresh.Queries {
		t.Run(string(query.Name), func(t *testing.T) {
			cache := queryCaches[query.Name](unheld)
			if query.Persisted {
				key, ok := keptKeys[query.Per]
				if !ok {
					t.Fatalf("%s is persisted, kept per %q, which no kept document's key is", query.Name, query.Per)
				}
				if cache.keyType() != key {
					t.Errorf("%s's cache is keyed by %s; the table keeps it per %q, a %s", query.Name, cache.keyType(), query.Per, key)
				}
			}
			ref, ok := readValueRef(query.Value.Ref)
			if !ok {
				t.Fatalf("%s's value is %q, which names no component or member within one", query.Name, query.Value.Ref)
			}
			if awaitingARuling[query.Name] {
				return
			}
			held := cache.valueType()
			if len(ref.members) == 0 {
				if held.PkgPath() != apiPath || held.Name() != ref.component {
					t.Errorf("%s's cache holds %s; the table's value is %s", query.Name, held, ref.component)
				}
				return
			}
			if want := memberOf(t, ref); held != want {
				t.Errorf("%s's cache holds %s; the table's value is %s's %s, a %s", query.Name, held, ref.component, strings.Join(ref.members, "."), want)
			}
		})
	}
}
