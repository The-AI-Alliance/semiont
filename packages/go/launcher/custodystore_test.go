package launcher

import (
	"fmt"
	"go/ast"
	"go/parser"
	gotoken "go/token"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

// Every custody value is read, written and located through custodyStore, so a
// backend changes custodystore.go and none of its callers, and no caller can
// skip the line that shows an operation. A census over the launcher's source:
// a backend reached directly, or a custody value's path built, anywhere else
// fails here.
func TestCustodyValuesGoThroughTheStore(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := gotoken.NewFileSet()
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") || strings.HasPrefix(f, "custodystore") {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			if lit, ok := n.(*ast.CompositeLit); ok {
				if id, ok := lit.Type.(*ast.Ident); ok && strings.HasSuffix(id.Name, "Backend") {
					t.Errorf("%s: a custody backend built outside the custody store", fset.Position(lit.Pos()))
				}
			}
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
				if inner, ok := sel.X.(*ast.SelectorExpr); ok && inner.Sel.Name == "b" {
					t.Errorf("%s: a custody backend reached past the store", fset.Position(call.Pos()))
				}
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

// captureOutput: what fn wrote to stdout and to stderr.
func captureOutput(t *testing.T, fn func()) (stdout, stderr string) {
	t.Helper()
	stderr = captureStderr(t, func() {
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatalf("pipe: %v", err)
		}
		old := os.Stdout
		os.Stdout = w
		defer func() { os.Stdout = old }()
		fn()
		_ = w.Close()
		b, err := io.ReadAll(r)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		stdout = string(b)
	})
	return stdout, stderr
}

// custodyStoreContract: what every backend does, files and 1Password alike. A
// value put is got back; a name never put reads as nothing kept; names lists
// what is kept; remove removes. And every operation is shown on the terminal
// before it runs — the operation and the secret's name, never its value.
func custodyStoreContract(t *testing.T, s custodyStore) {
	t.Helper()
	u := NewUI(false)
	value := "contract-value-5f0d7c1e9a"
	shows := func(label, out string, wants ...string) {
		t.Helper()
		for _, w := range wants {
			if !strings.Contains(out, w) {
				t.Errorf("%s: the terminal does not show %q:\n%s", label, w, out)
			}
		}
		if strings.Contains(out, value) {
			t.Errorf("%s: a secret's VALUE reached the terminal:\n%s", label, out)
		}
	}

	var ok bool
	stdout, stderr := captureOutput(t, func() { ok = s.put(u, "neo4j-password", value) })
	if !ok {
		t.Fatalf("put failed:\n%s", stderr)
	}
	shows("put", stdout+stderr, "secrets: write neo4j-password", s.b.where("neo4j-password"))

	var got string
	stdout, stderr = captureOutput(t, func() { got, ok = s.get(u, "neo4j-password") })
	if !ok || got != value {
		t.Errorf("get after put = (%q, %v), want the value put", got, ok)
	}
	shows("get", stdout+stderr, "secrets: read neo4j-password")

	stdout, stderr = captureOutput(t, func() { got, ok = s.get(u, "postgres-password") })
	if !ok || got != "" {
		t.Errorf("get of a name never put = (%q, %v), want nothing kept", got, ok)
	}
	shows("get of an absent name", stdout+stderr, "secrets: read postgres-password")

	var names []string
	stdout, stderr = captureOutput(t, func() { names, ok = s.names(u) })
	if !ok || !slices.Equal(names, []string{"neo4j-password"}) {
		t.Errorf("names = (%v, %v), want [neo4j-password]", names, ok)
	}
	shows("names", stdout+stderr, "secrets: list")

	stdout, stderr = captureOutput(t, func() { ok = s.remove(u, "neo4j-password") })
	if !ok {
		t.Errorf("remove failed:\n%s", stderr)
	}
	shows("remove", stdout+stderr, "secrets: delete neo4j-password")
	captureOutput(t, func() { got, ok = s.get(u, "neo4j-password") })
	if !ok || got != "" {
		t.Errorf("get after remove = (%q, %v), want nothing kept", got, ok)
	}
}

func TestFilesystemCustodyStoreKeepsTheContract(t *testing.T) {
	custodyStoreContract(t, custodyStore{fileBackend{dir: t.TempDir()}})
}

// fakeOpBin: the directory holding fakert built as `op` — the same fake the
// launcher's scenarios run — built once per test binary.
var fakeOpBin = sync.OnceValues(func() (string, error) {
	dir, err := os.MkdirTemp("", "fake-op")
	if err != nil {
		return "", err
	}
	if out, err := exec.Command("go", "build", "-o", filepath.Join(dir, harness.Exe("op")), "../fakert").CombinedOutput(); err != nil {
		return "", fmt.Errorf("building fakert as op: %v\n%s", err, out)
	}
	return dir, nil
})

// withFakeOp puts the fake 1Password CLI first on PATH, with an empty item
// store of its own.
func withFakeOp(t *testing.T, env ...string) {
	t.Helper()
	dir, err := fakeOpBin()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKERT_DIR", t.TempDir())
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		t.Setenv(k, v)
	}
}

func TestOnePasswordCustodyStoreKeepsTheContract(t *testing.T) {
	withFakeOp(t)
	custodyStoreContract(t, custodyStore{&opBackend{vault: "Semiont", title: opItemTitle("kb.example")}})
}

// One item per root, one concealed field per value: a skill reads a value
// with `op read`, at the reference the store names.
func TestOnePasswordCustodyStoreKeepsOneItemPerRoot(t *testing.T) {
	withFakeOp(t)
	u := NewUI(false)
	s := custodyStore{&opBackend{vault: "Semiont", title: opItemTitle("kb.example")}}
	captureOutput(t, func() {
		for _, name := range []string{"jwt-secret", "neo4j-password", "postgres-password"} {
			if !s.put(u, name, "value-of-"+name) {
				t.Fatalf("put %s failed", name)
			}
		}
	})
	b, err := os.ReadFile(filepath.Join(os.Getenv("FAKERT_DIR"), "op-items.json"))
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(b), `"title": "Semiont — kb.example"`); n != 1 {
		t.Errorf("%d items for one root, want one:\n%s", n, b)
	}
	if !strings.Contains(string(b), `"category": "SECURE_NOTE"`) || !strings.Contains(string(b), `"type": "CONCEALED"`) {
		t.Errorf("not a Secure Note of concealed fields:\n%s", b)
	}
	ref := strings.TrimPrefix(s.where("neo4j-password"), "op://")
	out, err := exec.Command("op", "read", "op://"+ref).Output()
	if err != nil || strings.TrimSpace(string(out)) != "value-of-neo4j-password" {
		t.Errorf("op read %s = %q, %v", ref, out, err)
	}
}

// A 1Password that does not answer is not an empty store: a read that could
// be taken for "nothing kept" would mint a replacement over a value that
// exists.
func TestOnePasswordCustodyStoreRefusesWhenOnePasswordDoesNotAnswer(t *testing.T) {
	withFakeOp(t, "FAKERT_OP_FAIL=1")
	u := NewUI(false)
	s := custodyStore{&opBackend{vault: "Semiont", title: opItemTitle("kb.example")}}
	var ok bool
	_, stderr := captureOutput(t, func() { _, ok = s.get(u, "jwt-secret") })
	if ok {
		t.Error("a store that did not answer read as one holding nothing")
	}
	mustShow(t, stderr, "1Password did not answer", `vault "Semiont"`, "never falls back")
}

func TestOnePasswordCustodyStoreRefusesAMissingVault(t *testing.T) {
	withFakeOp(t, "FAKERT_OP_VAULTS=Personal")
	u := NewUI(false)
	s := custodyStore{&opBackend{vault: "Semiont", title: opItemTitle("kb.example")}}
	var ok bool
	_, stderr := captureOutput(t, func() { ok = s.put(u, "jwt-secret", "v") })
	if ok {
		t.Error("a write to a vault that does not exist succeeded")
	}
	mustShow(t, stderr, `isn't a vault`, "1Password did not answer")
}

func mustShow(t *testing.T, out string, wants ...string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Errorf("missing %q in:\n%s", w, out)
		}
	}
}
