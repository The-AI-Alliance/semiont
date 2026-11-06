package semiont_test

// Nothing in the SDK waits or draws a jitter outside what its caller
// controls. Every wait is package time's, which testing/synctest moves for a
// caller whose call started the goroutine that waits; a deadline is one of
// those waits, never the HTTP client's own; and every jitter is drawn from the
// *rand.Rand the caller gave, or from the system's source where it gave none.
// The census reads the SDK's source, its test doubles in semionttest aside
// (their seeded generators make the same fault schedules every run, and back
// no wait), and refuses:
//   - an http.Client built with a Timeout, which keeps a deadline of the HTTP
//     client's own;
//   - an import of math/rand, whose global source no caller's reaches;
//   - a package function of math/rand/v2, which is a draw from the global
//     source or a generator of the SDK's own, unless it is in the branch of
//     an `if source == nil` whose source is a *rand.Rand its function is
//     given. That branch is the one place the system's source is drawn from.

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// randTypes is what math/rand/v2 names that is a type, and draws nothing.
var randTypes = []string{"ChaCha8", "PCG", "Rand", "Source", "Zipf"}

// clockEscapes is each line of file that waits or draws outside what the
// SDK's caller controls, and how many draws of the system's source it makes
// where the caller gave no source.
func clockEscapes(fset *token.FileSet, file *ast.File) (escapes []string, defaults int) {
	escape := func(at token.Pos, what string) {
		escapes = append(escapes, fmt.Sprintf("%d: %s", fset.Position(at).Line, what))
	}
	var randName, httpName string
	for _, spec := range file.Imports {
		path, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			escape(spec.Pos(), "an import that does not read: "+err.Error())
			continue
		}
		// An import not given a name is known by its package's.
		known := func(name string) string {
			if spec.Name != nil {
				return spec.Name.Name
			}
			return name
		}
		switch path {
		case "math/rand":
			escape(spec.Pos(), "an import of math/rand")
		case "math/rand/v2":
			randName = known("rand")
		case "net/http":
			httpName = known("http")
		}
	}
	var enclosing []ast.Node
	ast.Inspect(file, func(node ast.Node) bool {
		if node == nil {
			enclosing = enclosing[:len(enclosing)-1]
			return true
		}
		enclosing = append(enclosing, node)
		switch node := node.(type) {
		case *ast.SelectorExpr:
			if randName == "" || !isIdent(node.X, randName) || slices.Contains(randTypes, node.Sel.Name) {
				return true
			}
			if givenNoSource(enclosing, randName) {
				defaults++
			} else {
				escape(node.Pos(), "math/rand/v2's "+node.Sel.Name)
			}
		case *ast.CompositeLit:
			built, ok := node.Type.(*ast.SelectorExpr)
			if httpName == "" || !ok || !isIdent(built.X, httpName) || built.Sel.Name != "Client" {
				return true
			}
			for _, element := range node.Elts {
				if field, ok := element.(*ast.KeyValueExpr); ok && isIdent(field.Key, "Timeout") {
					escape(field.Pos(), "an http.Client built with a Timeout")
				}
			}
		}
		return true
	})
	return escapes, defaults
}

func isIdent(expression ast.Expr, name string) bool {
	ident, ok := expression.(*ast.Ident)
	return ok && ident.Name == name
}

// givenNoSource reports whether the last of enclosing, the nodes that enclose
// it before it, lies in the branch of an `if source == nil` whose source is a
// *rand.Rand the function around that if is given.
func givenNoSource(enclosing []ast.Node, randName string) bool {
	node := enclosing[len(enclosing)-1]
	for at := len(enclosing) - 2; at >= 0; at-- {
		branch, ok := enclosing[at].(*ast.IfStmt)
		if !ok || node.Pos() < branch.Body.Pos() || node.End() > branch.Body.End() {
			continue
		}
		test, ok := branch.Cond.(*ast.BinaryExpr)
		if !ok || test.Op != token.EQL || !isIdent(test.Y, "nil") {
			continue
		}
		source, ok := test.X.(*ast.Ident)
		if ok && givesRandSource(functionAround(enclosing[:at]), source.Name, randName) {
			return true
		}
	}
	return false
}

// functionAround is the type of the innermost function among enclosing; nil
// when there is none.
func functionAround(enclosing []ast.Node) *ast.FuncType {
	for at := len(enclosing) - 1; at >= 0; at-- {
		switch function := enclosing[at].(type) {
		case *ast.FuncDecl:
			return function.Type
		case *ast.FuncLit:
			return function.Type
		}
	}
	return nil
}

// givesRandSource reports whether function is given a parameter named name
// that is a *rand.Rand.
func givesRandSource(function *ast.FuncType, name, randName string) bool {
	if function == nil {
		return false
	}
	for _, field := range function.Params.List {
		pointer, ok := field.Type.(*ast.StarExpr)
		if !ok {
			continue
		}
		named, ok := pointer.X.(*ast.SelectorExpr)
		if !ok || !isIdent(named.X, randName) || named.Sel.Name != "Rand" {
			continue
		}
		for _, parameter := range field.Names {
			if parameter.Name == name {
				return true
			}
		}
	}
	return false
}

func TestTheClockCensusReadsWhatItIsShown(t *testing.T) {
	const sample = `package sample

import (
	"math/rand"
	random "math/rand/v2"
	web "net/http"
)

func jitter(cap int64, source *random.Rand) int64 {
	if source == nil {
		return random.Int64N(cap)
	}
	return source.Int64N(cap)
}

func escapes(source *random.Rand, count *int) {
	_ = rand.Intn(2)
	_ = random.Int64N(2)
	_ = random.New(random.NewPCG(1, 2))
	if source != nil {
		_ = random.Float64()
	}
	if count == nil {
		_ = random.N(3)
	}
	var _ *random.Rand
	_ = web.Client{}
	_ = &web.Client{Timeout: 5}
}
`
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "sample.go", sample, parser.SkipObjectResolution)
	if err != nil {
		t.Fatal(err)
	}
	escapes, defaults := clockEscapes(fset, file)
	want := []string{
		"4: an import of math/rand",
		"18: math/rand/v2's Int64N",
		"19: math/rand/v2's New",
		"19: math/rand/v2's NewPCG",
		"21: math/rand/v2's Float64",
		"24: math/rand/v2's N",
		"28: an http.Client built with a Timeout",
	}
	if !slices.Equal(escapes, want) || defaults != 1 {
		t.Fatalf("the census read %q and %d draws where no source was given; want %q and 1", escapes, defaults, want)
	}
}

func TestNothingInTheSDKWaitsOrDrawsOutsideWhatItsCallerControls(t *testing.T) {
	fset := token.NewFileSet()
	var found []string
	read, defaults := 0, 0
	err := filepath.WalkDir(".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			// conformance is a module of its own; semionttest is the test
			// doubles.
			if path == "conformance" || path == "semionttest" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		escapes, drawn := clockEscapes(fset, file)
		for _, escape := range escapes {
			found = append(found, path+":"+escape)
		}
		read++
		defaults += drawn
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if read < 50 {
		t.Fatalf("the census read %d files of the SDK's source: it read next to nothing", read)
	}
	if len(found) > 0 {
		t.Errorf("a wait or a draw the caller's clock and random source do not reach: %q", found)
	}
	if defaults != 1 {
		t.Errorf("the system's source is drawn from in %d places where the caller gave none; one place decides it", defaults)
	}
}
