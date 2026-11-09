package launcher

// control_census_test.go — the census gates of the control API: each
// hand-written statement of a shape protocol/specs/src/control owns, held to
// it, so the day either side grows the other fails.

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	gotoken "go/token"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
)

var controlSpecDir = filepath.Join("..", "..", "..", "protocol", "specs", "src", "control")

func readControlSpec(t *testing.T, name string, into any) {
	t.Helper()
	text, err := os.ReadFile(filepath.Join(controlSpecDir, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(text, into); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

// cliOption: one row of protocol/specs/src/control/cli.json.
type cliOption struct {
	Name    string   `json:"name"`
	Fields  []string `json:"fields"`
	Method  string   `json:"method"`
	CliOnly string   `json:"cliOnly"`
	Notes   string   `json:"notes"`
}

type cliCommand struct {
	Parser      string               `json:"parser"`
	Method      string               `json:"method"`
	CliOnly     string               `json:"cliOnly"`
	Positionals []cliOption          `json:"positionals"`
	Flags       map[string]cliOption `json:"flags"`
}

func readCLITable(t *testing.T) map[string]cliCommand {
	var table struct {
		Commands map[string]cliCommand `json:"commands"`
	}
	readControlSpec(t, "cli.json", &table)
	return table.Commands
}

// packageFiles: the package's own source, parsed: no test, nothing generated.
func packageFiles(t *testing.T) []*ast.File {
	t.Helper()
	names, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	var files []*ast.File
	fset := gotoken.NewFileSet()
	for _, name := range names {
		if strings.HasSuffix(name, "_test.go") || strings.HasSuffix(name, "_gen.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, f)
	}
	return files
}

// parsedFlags: every flag a case of the function name's switches reads.
func parsedFlags(t *testing.T, files []*ast.File, name string) []string {
	t.Helper()
	var fn *ast.FuncDecl
	for _, f := range files {
		for _, d := range f.Decls {
			if decl, ok := d.(*ast.FuncDecl); ok && decl.Recv == nil && decl.Name.Name == name {
				fn = decl
			}
		}
	}
	if fn == nil {
		t.Fatalf("no function %s in the package: cli.json names it as a parser", name)
	}
	seen := map[string]bool{}
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		clause, ok := n.(*ast.CaseClause)
		if !ok {
			return true
		}
		for _, expr := range clause.List {
			ast.Inspect(expr, func(n ast.Node) bool {
				if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == gotoken.STRING {
					if v, err := strconv.Unquote(lit.Value); err == nil && strings.HasPrefix(v, "-") {
						seen[v] = true
					}
				}
				return true
			})
		}
		return true
	})
	var out []string
	for f := range seen {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}

// methodParams: each method's params schema, by name.
func methodParams(t *testing.T) map[string]string {
	var table struct {
		Methods []struct {
			Name   string `json:"name"`
			Params string `json:"params"`
		} `json:"methods"`
	}
	readControlSpec(t, "methods.json", &table)
	out := map[string]string{}
	for _, m := range table.Methods {
		out[m.Name] = m.Params
	}
	return out
}

// schemaProperty: the schema of the member path names in the schema file
// names, following each $ref to a file of its own. ok=false: no such member.
func schemaProperty(t *testing.T, file string, path []string) (map[string]any, bool) {
	t.Helper()
	schema := schemaAt(t, file)
	for _, step := range path {
		properties, _ := schema["properties"].(map[string]any)
		next, ok := properties[step].(map[string]any)
		if !ok {
			return nil, false
		}
		schema = referenced(t, next)
	}
	return schema, true
}

// schemaAt: the schema of the file of protocol/specs/src/control named as
// methods.json and a $ref name it, its own $ref followed.
func schemaAt(t *testing.T, file string) map[string]any {
	t.Helper()
	var schema map[string]any
	readControlSpec(t, strings.TrimPrefix(file, "./"), &schema)
	return referenced(t, schema)
}

// referenced: schema, or, when it is a $ref to another file of the control
// directory, that file's schema.
func referenced(t *testing.T, schema map[string]any) map[string]any {
	t.Helper()
	ref, isRef := schema["$ref"].(string)
	if !isRef || strings.Contains(ref, "#") || strings.HasPrefix(ref, "../") {
		return schema
	}
	return schemaAt(t, ref)
}

// splitField: a cli.json field, <method>.<path>, as its method and path.
func splitField(field string) (string, []string) {
	parts := strings.Split(field, ".")
	return parts[0] + "." + parts[1], parts[2:]
}

// Each command's options, as its parser's switches read them, are cli.json's,
// both ways; each states what it is in the API, once; each field it names is
// a member of its method's params; each method it names is a method.
func TestControlCLICensus(t *testing.T) {
	files := packageFiles(t)
	params := methodParams(t)
	for name, cmd := range readCLITable(t) {
		t.Run(name, func(t *testing.T) {
			if (cmd.Method == "") == (cmd.CliOnly == "") {
				t.Errorf("states a method or why it has none (cliOnly), and not both")
			}
			if _, ok := params[cmd.Method]; cmd.Method != "" && !ok {
				t.Errorf("names the method %s, which methods.json has none of", cmd.Method)
			}
			var stated []string
			for flag := range cmd.Flags {
				stated = append(stated, flag)
			}
			sort.Strings(stated)
			if parsed := parsedFlags(t, files, cmd.Parser); !slices.Equal(parsed, stated) {
				t.Errorf("%s reads %v; cli.json states %v", cmd.Parser, parsed, stated)
			}
			options := slices.Clone(cmd.Positionals)
			for flag, o := range cmd.Flags {
				o.Name = flag
				options = append(options, o)
			}
			for _, o := range options {
				kinds := 0
				for _, set := range []bool{len(o.Fields) > 0, o.Method != "", o.CliOnly != ""} {
					if set {
						kinds++
					}
				}
				if kinds != 1 {
					t.Errorf("%s states %d of fields, method and cliOnly; each option states one", o.Name, kinds)
				}
				if _, ok := params[o.Method]; o.Method != "" && !ok {
					t.Errorf("%s selects %s, which methods.json has none of", o.Name, o.Method)
				}
				for _, field := range o.Fields {
					method, path := splitField(field)
					file, ok := params[method]
					if !ok {
						t.Errorf("%s maps %s, of %s, which methods.json has none of", o.Name, field, method)
						continue
					}
					if _, ok := schemaProperty(t, file, path); !ok {
						t.Errorf("%s maps %s, which %s has no member at", o.Name, field, file)
					}
				}
			}
		})
	}
}

// sampleParams: params of method with the one member field names set, for
// each value that member can take as far as the argv census asks: both of a
// flag's, the first of an enumeration, a placeholder for any other string. A
// target is set whole, as each kind of it is.
func sampleParams(t *testing.T, file string, path []string) []map[string]any {
	t.Helper()
	base := func() map[string]any { return map[string]any{"apiVersion": controlAPIVersion} }
	if path[0] == "target" {
		p := base()
		switch path[1] {
		case "root":
			p["target"] = map[string]any{"kind": "local", "root": "sample-root"}
		default:
			p["target"] = map[string]any{"kind": "codespace", "repo": "owner/name"}
		}
		return []map[string]any{p}
	}
	schema, ok := schemaProperty(t, file, path)
	if !ok {
		t.Fatalf("%s has no member %v", file, path)
	}
	var values []any
	switch {
	case schema["type"] == "boolean":
		values = []any{true, false}
	case schema["enum"] != nil:
		values = []any{schema["enum"].([]any)[0]}
	default:
		values = []any{"sample"}
	}
	var out []map[string]any
	for _, v := range values {
		p := base()
		p[path[0]] = v
		out = append(out, p)
	}
	return out
}

// The command line a control request is turned into names each option whose
// field the request sets: every field cli.json maps to a flag of start or stop
// reaches that flag through startArgs or stopArgs, and a request that sets none
// is the bare command.
func TestControlArgvCensus(t *testing.T) {
	commands := readCLITable(t)
	params := methodParams(t)
	builders := map[string]func(text []byte) []string{
		"stack.start": func(text []byte) []string {
			var p ControlStackStartParams
			if err := json.Unmarshal(text, &p); err != nil {
				t.Fatal(err)
			}
			return startArgs(p)
		},
		"stack.stop": func(text []byte) []string {
			var p ControlStackStopParams
			if err := json.Unmarshal(text, &p); err != nil {
				t.Fatal(err)
			}
			return stopArgs(p)
		},
	}
	for _, name := range []string{"start", "stop"} {
		cmd := commands[name]
		build := builders[cmd.Method]
		bare, _ := json.Marshal(map[string]any{"apiVersion": controlAPIVersion})
		if args := build(bare); len(args) != 0 {
			t.Errorf("%s of no options is %v, want the bare command", cmd.Method, args)
		}
		for flag, o := range cmd.Flags {
			for _, field := range o.Fields {
				method, path := splitField(field)
				reached := false
				for _, sample := range sampleParams(t, params[method], path) {
					text, _ := json.Marshal(sample)
					reached = reached || slices.Contains(build(text), flag)
				}
				if !reached {
					t.Errorf("%s maps %s to %s, and no request setting it is given %s", name, flag, field, flag)
				}
			}
		}
	}
}

// schemaEnum: the enumeration of the schema file names.
func schemaEnum(t *testing.T, file string, path ...string) []string {
	t.Helper()
	schema, ok := schemaProperty(t, file, path)
	if !ok {
		t.Fatalf("%s has no member %v", file, path)
	}
	var out []string
	for _, v := range schema["enum"].([]any) {
		out = append(out, v.(string))
	}
	return out
}

// The runtimes Runtime.json admits are the ones the launcher drives, in its
// order.
func TestControlRuntimesAreTheLaunchers(t *testing.T) {
	if got := schemaEnum(t, "Runtime.json"); !slices.Equal(got, runtimeOrder) {
		t.Errorf("Runtime.json admits %v; the launcher drives %v", got, runtimeOrder)
	}
}

// The groups ServiceGroup.json names are the launcher's serviceGroups, in its
// order.
func TestControlServiceGroupsAreTheLaunchers(t *testing.T) {
	var groups []string
	for _, g := range serviceGroups {
		groups = append(groups, g.name)
	}
	if got := schemaEnum(t, "ServiceGroup.json"); !slices.Equal(got, groups) {
		t.Errorf("ServiceGroup.json names %v; the launcher's groups are %v", got, groups)
	}
}

// What a setting applies to, as Setting.json names it, is what the settings
// table's settings apply to.
func TestControlSettingsApplyAsTheTableSays(t *testing.T) {
	if got, want := schemaEnum(t, "Setting.json", "appliesTo"), []string{appliesToMachine, appliesToKB}; !slices.Equal(got, want) {
		t.Errorf("Setting.json's settings apply to %v; the settings table's, to %v", got, want)
	}
	for _, s := range settingsTable {
		if s.appliesTo != appliesToMachine && s.appliesTo != appliesToKB {
			t.Errorf("%s applies to %q, which Setting.json does not name", s.name, s.appliesTo)
		}
	}
}

// The kinds a UI says its lines as are Progress.json's, both ways: UI.say's
// (its writer, then its kind), UI.said's and a request's progress (the kind
// first).
func TestControlProgressKindsAreTheUIs(t *testing.T) {
	said := map[string]bool{}
	for _, f := range packageFiles(t) {
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			at := -1
			switch sel.Sel.Name {
			case "say":
				if len(call.Args) == 4 {
					if _, writer := call.Args[0].(*ast.SelectorExpr); writer {
						at = 1
					}
				}
			case "said", "progress":
				at = 0
			}
			if at < 0 || len(call.Args) <= at {
				return true
			}
			if lit, ok := call.Args[at].(*ast.BasicLit); ok && lit.Kind == gotoken.STRING {
				kind, _ := strconv.Unquote(lit.Value)
				said[kind] = true
			}
			return true
		})
	}
	var got []string
	for kind := range said {
		got = append(got, kind)
	}
	sort.Strings(got)
	want := schemaEnum(t, "Progress.json", "kind")
	sort.Strings(want)
	if !slices.Equal(got, want) {
		t.Errorf("the UI says its lines as %v; Progress.json's kinds are %v", got, want)
	}
}

// Every code of codes.json's control group is one the launcher fails with:
// its constant is named outside the generated files.
func TestEveryControlCodeIsUsed(t *testing.T) {
	fset := gotoken.NewFileSet()
	gen, err := parser.ParseFile(fset, "control_schemas_gen.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	constants := map[string]string{}
	for _, d := range gen.Decls {
		decl, ok := d.(*ast.GenDecl)
		if !ok || decl.Tok != gotoken.CONST {
			continue
		}
		for _, spec := range decl.Specs {
			v := spec.(*ast.ValueSpec)
			if lit, ok := v.Values[0].(*ast.BasicLit); ok && lit.Kind == gotoken.STRING {
				if code, _ := strconv.Unquote(lit.Value); slices.Contains(controlCodes, code) {
					constants[v.Names[0].Name] = code
				}
			}
		}
	}
	if len(constants) != len(controlCodes) {
		t.Fatalf("control_schemas_gen.go names %d of the %d control codes as constants", len(constants), len(controlCodes))
	}
	named := map[string]bool{}
	for _, f := range packageFiles(t) {
		ast.Inspect(f, func(n ast.Node) bool {
			if id, ok := n.(*ast.Ident); ok {
				named[id.Name] = true
			}
			return true
		})
	}
	for constant, code := range constants {
		if !named[constant] {
			t.Errorf("%s is a control code the launcher never fails with: nothing names %s", code, constant)
		}
	}
}

// Each method of methods.json has a handler, and each handler a method.
func TestEveryControlMethodHasAHandler(t *testing.T) {
	var methods, handled []string
	for _, m := range controlMethods {
		methods = append(methods, m.name)
	}
	for name := range controlHandlers {
		handled = append(handled, name)
	}
	sort.Strings(methods)
	sort.Strings(handled)
	if !slices.Equal(methods, handled) {
		t.Errorf("methods.json's methods are %v; the handlers are %v", methods, handled)
	}
}

// applyingKeywords: the JSON Schema keywords that never refuse a value
// themselves: they annotate, or apply a schema whose own keywords refuse.
var applyingKeywords = []string{"$comment", "$ref", "description", "items", "properties", "title"}

// schemaKeywords: the keywords schema uses, its subschemas' included.
func schemaKeywords(schema map[string]any, into map[string]bool) {
	for keyword, value := range schema {
		into[keyword] = true
		switch keyword {
		case "properties":
			for _, member := range value.(map[string]any) {
				schemaKeywords(member.(map[string]any), into)
			}
		case "items", "not", "additionalProperties":
			if sub, ok := value.(map[string]any); ok {
				schemaKeywords(sub, into)
			}
		case "oneOf":
			for _, form := range value.([]any) {
				schemaKeywords(form.(map[string]any), into)
			}
		}
	}
}

// faultKindsOfSchemaFaults: the kind.X types schemaFaults's type switch
// names, each as the keyword it is the fault of.
func faultKindsOfSchemaFaults(t *testing.T) []string {
	f, err := parser.ParseFile(gotoken.NewFileSet(), "control_validate.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var keywords []string
	ast.Inspect(f, func(n ast.Node) bool {
		decl, ok := n.(*ast.FuncDecl)
		if !ok || decl.Name.Name != "schemaFaults" {
			return true
		}
		ast.Inspect(decl.Body, func(n ast.Node) bool {
			clause, ok := n.(*ast.CaseClause)
			if !ok {
				return true
			}
			for _, expr := range clause.List {
				star, ok := expr.(*ast.StarExpr)
				if !ok {
					t.Fatalf("schemaFaults has a case that is no *kind type: %T", expr)
				}
				name := star.X.(*ast.SelectorExpr).Sel.Name
				keywords = append(keywords, strings.ToLower(name[:1])+name[1:])
			}
			return true
		})
		return false
	})
	sort.Strings(keywords)
	return keywords
}

// The keywords that can refuse a value in the control schemas are exactly the
// ones the launcher's schemaFaults says a fault for: a schema that grows a
// keyword fails here, not as a fault nobody locates.
func TestControlFaultKeywordsAreTheSchemas(t *testing.T) {
	names, err := filepath.Glob(filepath.Join(controlSpecDir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	used := map[string]bool{}
	for _, name := range names {
		switch filepath.Base(name) {
		case "cli.json", "methods.json", "request-cases.json":
			continue
		}
		var schema map[string]any
		readControlSpec(t, filepath.Base(name), &schema)
		schemaKeywords(schema, used)
	}
	var refusing []string
	for keyword := range used {
		if !slices.Contains(applyingKeywords, keyword) {
			refusing = append(refusing, keyword)
		}
	}
	sort.Strings(refusing)
	if launcher := faultKindsOfSchemaFaults(t); !slices.Equal(launcher, refusing) {
		t.Errorf("the control schemas refuse by %v; the launcher's schemaFaults says faults of %v", refusing, launcher)
	}
}
