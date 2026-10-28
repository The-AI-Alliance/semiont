package launcher

// issuerproxy.go — the filtering proxy that serves the issuer to the network
// under `network lan` (LOCAL-ONLY-STACK D3b-A1). Keycloak serves its admin
// console, its admin API and the master realm on the same port as the realm's
// sign-in, and has no way to keep them apart, so the network is given a proxy
// that passes the knowledge base's realm and the assets its pages load, and
// nothing else. Keycloak itself is published on the bridge address, for the
// proxy and the launcher's own administration (exposure.keycloakAt).
//
// The proxy is the launcher run again as `semiont issuer-proxy`, detached and
// recorded like a codespace forward: a start replaces it, stop ends it, and
// status restarts one that died. Under `network lan` everyone's sign-in goes
// through it, the containers' included, so while it is down nobody signs in
// or refreshes a token.

import (
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// IssuerProxyVerb: the launcher's own verb for the proxy, which `semiont
// --help` does not list: a person never runs it.
const IssuerProxyVerb = "issuer-proxy"

// issuerPathAllowed: whether the proxy passes p — the realm's own paths and
// Keycloak's static assets (Keycloak's reverse-proxy guide: `/realms/` and
// `/resources/` exposed, `/admin/` and `/realms/master/` only internally). A
// path that does not read the same once cleaned is refused, so `..` cannot
// walk out of either.
func issuerPathAllowed(realm, p string) bool {
	clean := path.Clean(p)
	if p != clean && p != clean+"/" {
		return false
	}
	realmRoot := "/realms/" + realm
	return clean == realmRoot || strings.HasPrefix(clean, realmRoot+"/") || strings.HasPrefix(clean, "/resources/")
}

// issuerProxyHandler: the proxy's handler, passing what issuerPathAllowed
// allows to upstream and answering 404 for the rest. A path written with
// escapes it need not have (RawPath set) is refused too: what is checked is
// what is sent.
func issuerProxyHandler(upstream *url.URL, realm string) http.Handler {
	proxy := &httputil.ReverseProxy{
		ErrorLog: issuerProxyLog,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			// Keycloak names the endpoints behind its fixed hostname at the
			// address a request asked (--hostname-backchannel-dynamic), so the
			// proxy keeps the one its caller asked: discovery fetched through it
			// names endpoints its caller reaches, not the bridge address.
			r.Out.Host = r.In.Host
		},
		Transport: launcherTransport,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawPath != "" || !issuerPathAllowed(realm, r.URL.Path) {
			http.Error(w, "Not served at this address.", http.StatusNotFound)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

// issuerProxyLog: the proxy's error log, which keeps nothing. Its stderr is a
// pipe to the start that spawned it (startDetached), gone once that start
// ends, and a Go process that writes to a broken pipe on fd 2 exits (SIGPIPE):
// a line for a request a browser abandoned would end the proxy.
var issuerProxyLog = log.New(io.Discard, "", 0)

// issuerProxyArgs: the proxy's arguments, after the launcher's own path.
func issuerProxyArgs(listen, upstream, realm string) []string {
	return []string{IssuerProxyVerb, "--listen", listen, "--upstream", upstream, "--realm", realm}
}

// IssuerProxy implements `semiont issuer-proxy --listen <host:port> --upstream
// <host:port> --realm <name>`, serving until it is ended.
func IssuerProxy(args []string) int {
	flags := map[string]string{"--listen": "", "--upstream": "", "--realm": ""}
	for i := 0; i < len(args); i++ {
		if _, ok := flags[args[i]]; !ok || i+1 >= len(args) {
			fmt.Fprintf(os.Stderr, "issuer proxy: unexpected argument %q\n", args[i])
			return 64
		}
		flags[args[i]] = args[i+1]
		i++
	}
	for name, v := range flags {
		if v == "" {
			fmt.Fprintf(os.Stderr, "issuer proxy: %s is required\n", name)
			return 64
		}
	}
	host, port, err := net.SplitHostPort(flags["--listen"])
	if err != nil {
		fmt.Fprintf(os.Stderr, "issuer proxy: --listen %q: %v\n", flags["--listen"], err)
		return 64
	}
	srv := &http.Server{
		Addr:              net.JoinHostPort(listenHost(host), port),
		Handler:           issuerProxyHandler(&url.URL{Scheme: "http", Host: flags["--upstream"]}, flags["--realm"]),
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          issuerProxyLog,
	}
	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintf(os.Stderr, "issuer proxy: %v\n", err)
		return 1
	}
	return 0
}

// issuerProxyReadyBudget: how long a start waits for a proxy it started to
// accept connections.
const issuerProxyReadyBudget = 5 * time.Second

// spawnIssuerProxy starts the proxy detached and returns its pid once it
// accepts connections at listen.
func spawnIssuerProxy(u *UI, listen, upstream, realm string) (int, bool) {
	self, err := os.Executable()
	if err != nil {
		u.Fail("The issuer proxy cannot start: the launcher's own path is unknown: %v", err)
		return 0, false
	}
	args := issuerProxyArgs(listen, upstream, realm)
	u.EchoCmd(self, args...)
	pid, dead, err := startDetached(self, args...)
	if err != nil {
		u.Fail("The issuer proxy did not start: %v", err)
		return 0, false
	}
	host, portText, _ := net.SplitHostPort(listen)
	port, _ := strconv.Atoi(portText)
	deadline := time.Now().Add(issuerProxyReadyBudget)
	for {
		select {
		case <-dead:
			u.Fail("The issuer proxy exited: %s", lastForwardError(pid))
			return 0, false
		default:
		}
		if conn, err := dialTCP(host, port, 500*time.Millisecond); err == nil {
			conn.Close()
			return pid, true
		}
		if time.Now().After(deadline) {
			terminateProcess(pid)
			u.Fail("The issuer proxy did not accept connections at %s within %s.", listen, took(issuerProxyReadyBudget))
			return 0, false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// issuerProxyAlive: whether pid is a running issuer proxy — a running process
// of this launcher's own executable, so a pid reused by another process is
// never taken for it, or ended.
func issuerProxyAlive(pid int) bool {
	if pid == 0 || !processAlive(pid) {
		return false
	}
	self, err := os.Executable()
	if err != nil {
		return false
	}
	// processName names the image without its .exe on Windows.
	name := strings.TrimSuffix(filepath.Base(self), filepath.Ext(self))
	return strings.Contains(processName(strconv.Itoa(pid)), name)
}

// retireIssuerProxy ends the issuer proxy the local stack's record names, if
// one runs, and forgets it.
func retireIssuerProxy(u *UI) {
	st := loadLocalState()
	if st == nil || st.IssuerProxy == nil {
		return
	}
	endIssuerProxy(u, st)
	saveStack(st)
}

// endIssuerProxy ends st's issuer proxy, if one runs, and forgets it in st;
// saving st is the caller's.
func endIssuerProxy(u *UI, st *StackState) {
	if st.IssuerProxy == nil {
		return
	}
	if issuerProxyAlive(st.IssuerProxy.PID) {
		u.Log("Stopping the issuer proxy %s", u.Dim(fmt.Sprintf("(pid %d)", st.IssuerProxy.PID)))
		terminateProcess(st.IssuerProxy.PID)
	}
	st.IssuerProxy = nil
}

// reviveIssuerProxy starts the recorded issuer proxy again when it has died,
// as status does for a codespace forward: under `network lan` nobody signs in
// without it.
func reviveIssuerProxy(u *UI, st *StackState) {
	p := st.IssuerProxy
	if p == nil || issuerProxyAlive(p.PID) {
		return
	}
	u.Warn("The issuer proxy %s is not running; starting it again.", u.Dim(fmt.Sprintf("(pid %d)", p.PID)))
	pid, ok := spawnIssuerProxy(u, p.Listen, p.Upstream, p.Realm)
	if !ok {
		return
	}
	p.PID = pid
	saveStack(st)
}
