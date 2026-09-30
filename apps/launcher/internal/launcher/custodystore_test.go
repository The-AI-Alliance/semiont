package launcher

import (
	"go/ast"
	"go/parser"
	gotoken "go/token"
	"path/filepath"
	"strings"
	"testing"
)

// Every custody value is read, written and located through custodyStore, so a
// second backend (SECRETS-STORE P2) changes custodystore.go and none of its
// callers. A census over the launcher's source: the file primitives called, or
// a custody value's path built, anywhere else fails here.
func TestCustodyValuesGoThroughTheStore(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := gotoken.NewFileSet()
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") || f == "custodystore.go" {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			if id, ok := call.Fun.(*ast.Ident); ok && (id.Name == "readPersistedSecret" || id.Name == "persistSecret") {
				t.Errorf("%s: %s outside the custody store", fset.Position(call.Pos()), id.Name)
			}
			if sel, ok := call.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Join" && isPkg(sel.X, "filepath") {
				for _, arg := range call.Args {
					if namesCustody(arg) {
						t.Errorf("%s: a custody value's path built outside the custody store", fset.Position(call.Pos()))
					}
				}
			}
			return true
		})
	}
}

// namesCustody: whether an expression names a custody value — the store's own
// key constants and helpers, or a daemon's custody name.
func namesCustody(e ast.Expr) bool {
	found := false
	ast.Inspect(e, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.Ident:
			found = found || strings.HasPrefix(x.Name, "custody") && x.Name != "custodyFor"
		case *ast.SelectorExpr:
			found = found || x.Sel.Name == "custody"
		case *ast.CallExpr:
			if id, ok := x.Fun.(*ast.Ident); ok && id.Name == "serviceClientCustody" {
				found = true
			}
		}
		return !found
	})
	return found
}
