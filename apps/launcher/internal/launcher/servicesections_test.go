package launcher

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	gotoken "go/token"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// Which config sections each Node service reads is one list in two languages:
// specs/src/service-config/sections.json, which the TypeScript loader
// generates from and enforces. The launcher forwards by its copy, so the copy
// must be the spec.
func TestServiceSectionsAgreeWithTheSpec(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "specs", "src", "service-config", "sections.json"))
	if err != nil {
		t.Fatalf("reading the spec: %v", err)
	}
	var spec struct {
		Services map[string][]string `json:"services"`
	}
	if err := json.Unmarshal(b, &spec); err != nil {
		t.Fatalf("parsing the spec: %v", err)
	}
	if len(spec.Services) == 0 {
		t.Fatal("the spec lists no services: a gate that compares nothing passes on silence")
	}
	if !reflect.DeepEqual(serviceConfigSections, spec.Services) {
		t.Errorf("serviceConfigSections disagrees with specs/src/service-config/sections.json:\n launcher %v\n spec     %v", serviceConfigSections, spec.Services)
	}
}

// launcherReads is a census: the sections whose ${VAR} values the launcher
// resolves itself, read from the calls that resolve them. Each call names its
// field as "<section>.<key>", so a new resolve of a section the list lacks
// fails here, where start would otherwise not demand the variables it reads.
func TestLauncherReadsAreTheSectionsTheLauncherResolves(t *testing.T) {
	primitives := map[string]bool{"resolveRefs": true, "secretName": true, "externalCredential": true}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := gotoken.NewFileSet()
	resolved := map[string]bool{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || primitives[fn.Name.Name] {
				continue
			}
			ast.Inspect(fn, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				id, ok := call.Fun.(*ast.Ident)
				if !ok || !primitives[id.Name] {
					return true
				}
				lit, ok := call.Args[0].(*ast.BasicLit)
				if !ok || lit.Kind != gotoken.STRING {
					t.Errorf("%s: %s's field is not a literal, so the census cannot tell which section it reads", fset.Position(call.Pos()), id.Name)
					return true
				}
				field, _ := strconv.Unquote(lit.Value)
				section, _, _ := strings.Cut(field, ".")
				resolved[section] = true
				return true
			})
		}
	}
	var got []string
	for s := range resolved {
		got = append(got, s)
	}
	sort.Strings(got)
	// A set: two roles may resolve the same section (the gateway's and the
	// dispatcher's documents both read [gateway] and [identity]).
	wanted := map[string]bool{}
	for _, sections := range launcherReads {
		for _, s := range sections {
			wanted[s] = true
		}
	}
	var want []string
	for s := range wanted {
		want = append(want, s)
	}
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("the launcher resolves %v, but launcherReads lists %v", got, want)
	}
}
