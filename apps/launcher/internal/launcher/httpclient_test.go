package launcher

import (
	"context"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	gotoken "go/token"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A minimal Linux host resolves no *.localhost name (measured in
// the official Go image: `getent hosts keycloak.localhost` is empty), yet the issuer of
// a Docker or Podman stack is keycloak.localhost. The launcher resolves those
// names itself, so a resolver that knows none of them still reaches loopback.
func TestLocalhostNamesReachLoopbackWithoutTheSystemResolver(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "loopback")
	}))
	t.Cleanup(srv.Close)
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))

	prev := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) {
		return nil, errors.New("this resolver knows no names")
	}}
	t.Cleanup(func() { net.DefaultResolver = prev })

	c := &http.Client{Transport: launcherTransport, Timeout: 5 * time.Second}
	resp, err := c.Get("http://keycloak.localhost:" + port + "/")
	if err != nil {
		t.Fatalf("keycloak.localhost did not reach loopback: %v", err)
	}
	resp.Body.Close()
}

// Every HTTP request the launcher makes goes through launcherTransport, so no
// client resolves *.localhost through the system. A census over the launcher's
// source: an http.Client literal without it, or the package-level default
// client, fails here.
func TestEveryHTTPClientUsesTheLauncherTransport(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := gotoken.NewFileSet()
	clients := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.CompositeLit:
				sel, ok := x.Type.(*ast.SelectorExpr)
				if !ok || sel.Sel.Name != "Client" || !isPkg(sel.X, "http") {
					return true
				}
				clients++
				for _, el := range x.Elts {
					if kv, ok := el.(*ast.KeyValueExpr); ok {
						if k, ok := kv.Key.(*ast.Ident); ok && k.Name == "Transport" {
							if v, ok := kv.Value.(*ast.Ident); ok && v.Name == "launcherTransport" {
								return true
							}
						}
					}
				}
				t.Errorf("%s: an http.Client without Transport: launcherTransport", fset.Position(x.Pos()))
			case *ast.SelectorExpr:
				if isPkg(x.X, "http") {
					switch x.Sel.Name {
					case "DefaultTransport":
						if f != "httpclient.go" { // launcherTransport's own base
							t.Errorf("%s: http.%s bypasses launcherTransport", fset.Position(x.Pos()), x.Sel.Name)
						}
					case "DefaultClient", "Get", "Head", "Post", "PostForm":
						t.Errorf("%s: http.%s bypasses launcherTransport", fset.Position(x.Pos()), x.Sel.Name)
					}
				}
			}
			return true
		})
	}
	if clients == 0 {
		t.Fatal("the census found no http.Client: a gate that counts nothing passes on silence")
	}
}

func isPkg(e ast.Expr, name string) bool {
	id, ok := e.(*ast.Ident)
	return ok && id.Name == name
}
