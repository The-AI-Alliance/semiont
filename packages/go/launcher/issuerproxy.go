package launcher

// issuerproxy.go — the filtering proxy that serves the shared issuer to the
// network under `network lan`. Keycloak serves its admin console, its admin
// API and the master realm on the same port as the realms' sign-in, and has
// no way to keep them apart, so the network is given a proxy that passes the
// realms of the knowledge bases whose stacks are recorded and the assets
// their pages load, and nothing else. Keycloak itself is published on the
// bridge address, for the proxy and the launcher's own administration
// (exposure.keycloakAt).
//
// The proxy is the launcher run again as `semiont issuer-proxy`, detached and
// recorded beside the shared containers: one for the machine, as the Keycloak
// it fronts is. A start keeps it while it passes the realms that start would
// have it pass, and replaces it otherwise; a stop that leaves other stacks
// replaces it without the stopped one's realm, the last stack's stop ends it,
// and status restarts one that died. Under `network lan` everyone's sign-in
// goes through it, the containers' included, so while it is down nobody signs
// in or refreshes a token.

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
	"slices"
	"strconv"
	"strings"
	"time"
)

// IssuerProxyVerb: the launcher's own verb for the proxy, which `semiont
// --help` does not list: a person never runs it.
const IssuerProxyVerb = "issuer-proxy"

// issuerPathAllowed: whether the proxy passes p — one of the realms' own
// paths, or Keycloak's static assets (Keycloak's reverse-proxy guide:
// `/realms/` and `/resources/` exposed, `/admin/` and `/realms/master/` only
// internally). A path that does not read the same once cleaned is refused, so
// `..` cannot walk out of either.
func issuerPathAllowed(realms []string, p string) bool {
	clean := path.Clean(p)
	if p != clean && p != clean+"/" {
		return false
	}
	if strings.HasPrefix(clean, "/resources/") {
		return true
	}
	for _, realm := range realms {
		realmRoot := "/realms/" + realm
		if clean == realmRoot || strings.HasPrefix(clean, realmRoot+"/") {
			return true
		}
	}
	return false
}

// issuerProxyHandler: the proxy's handler, passing what issuerPathAllowed
// allows to upstream and answering 404 for the rest. A path written with
// escapes it need not have (RawPath set) is refused too: what is checked is
// what is sent.
func issuerProxyHandler(upstream *url.URL, realms []string) http.Handler {
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
		if r.URL.RawPath != "" || !issuerPathAllowed(realms, r.URL.Path) {
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
func issuerProxyArgs(listen, upstream string, realms []string) []string {
	args := []string{IssuerProxyVerb, "--listen", listen, "--upstream", upstream}
	for _, realm := range realms {
		args = append(args, "--realm", realm)
	}
	return args
}

// IssuerProxy implements `semiont issuer-proxy --listen <host:port> --upstream
// <host:port> --realm <name>...`, serving until it is ended.
func IssuerProxy(args []string) int {
	flags := map[string]string{"--listen": "", "--upstream": ""}
	var realms []string
	for i := 0; i < len(args); i++ {
		_, known := flags[args[i]]
		if !known && args[i] != "--realm" || i+1 >= len(args) {
			fmt.Fprintf(os.Stderr, "issuer proxy: unexpected argument %q\n", args[i])
			return 64
		}
		if known {
			flags[args[i]] = args[i+1]
		} else {
			realms = append(realms, args[i+1])
		}
		i++
	}
	for name, v := range flags {
		if v == "" {
			fmt.Fprintf(os.Stderr, "issuer proxy: %s is required\n", name)
			return 64
		}
	}
	if len(realms) == 0 {
		fmt.Fprintln(os.Stderr, "issuer proxy: --realm is required")
		return 64
	}
	host, port, err := net.SplitHostPort(flags["--listen"])
	if err != nil {
		fmt.Fprintf(os.Stderr, "issuer proxy: --listen %q: %v\n", flags["--listen"], err)
		return 64
	}
	srv := &http.Server{
		Addr:              net.JoinHostPort(listenHost(host), port),
		Handler:           issuerProxyHandler(&url.URL{Scheme: "http", Host: flags["--upstream"]}, realms),
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
func spawnIssuerProxy(u *UI, listen, upstream string, realms []string) (int, bool) {
	self, err := os.Executable()
	if err != nil {
		u.Fail("The issuer proxy cannot start: the launcher's own path is unknown: %v", err)
		return 0, false
	}
	args := issuerProxyArgs(listen, upstream, realms)
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

// retireIssuerProxy ends the issuer proxy the record names, if one runs, and
// forgets it.
func retireIssuerProxy(u *UI) {
	p := LoadStackSet().IssuerProxy
	if p == nil {
		return
	}
	if issuerProxyAlive(p.PID) {
		u.Log("Stopping the issuer proxy %s", u.Dim(fmt.Sprintf("(pid %d)", p.PID)))
		terminateProcess(p.PID)
		// A proxy that replaces it listens at the same address.
		for deadline := time.Now().Add(issuerProxyReadyBudget); issuerProxyAlive(p.PID) && time.Now().Before(deadline); {
			time.Sleep(50 * time.Millisecond)
		}
	}
	saveIssuerProxy(nil)
}

// ensureIssuerProxy keeps the recorded issuer proxy when it runs as asked —
// listening at listen, passing to upstream, and passing realms — and
// otherwise replaces it with one that does, recording it. kept says which.
func ensureIssuerProxy(u *UI, listen, upstream string, realms []string) (pid int, kept, ok bool) {
	if p := LoadStackSet().IssuerProxy; p != nil && issuerProxyAlive(p.PID) && p.Listen == listen && p.Upstream == upstream && slices.Equal(p.Realms, realms) {
		return p.PID, true, true
	}
	retireIssuerProxy(u)
	if pid, ok = spawnIssuerProxy(u, listen, upstream, realms); !ok {
		return 0, false, false
	}
	saveIssuerProxy(&issuerProxyRecord{PID: pid, Listen: listen, Upstream: upstream, Realms: realms})
	return pid, false, true
}

// withoutRealm: what a stop of the stack whose realm is realm leaves of the
// issuer proxy — the same proxy passing the other recorded stacks' realms, or
// none when it passed that realm alone. A proxy that does not pass it is left
// as it is.
func withoutRealm(u *UI, realm string) {
	p := LoadStackSet().IssuerProxy
	if p == nil || !slices.Contains(p.Realms, realm) {
		return
	}
	rest := slices.DeleteFunc(slices.Clone(p.Realms), func(r string) bool { return r == realm })
	if len(rest) == 0 {
		retireIssuerProxy(u)
		return
	}
	if _, _, ok := ensureIssuerProxy(u, p.Listen, p.Upstream, rest); ok {
		u.Log("Issuer proxy passes %s", u.Dim(strings.Join(rest, ", ")))
	}
}

// reviveIssuerProxy starts the recorded issuer proxy again when it has died,
// as status does for a codespace forward: under `network lan` nobody signs in
// without it.
func reviveIssuerProxy(u *UI) {
	p := LoadStackSet().IssuerProxy
	if p == nil || issuerProxyAlive(p.PID) {
		return
	}
	u.Warn("The issuer proxy %s is not running; starting it again.", u.Dim(fmt.Sprintf("(pid %d)", p.PID)))
	pid, ok := spawnIssuerProxy(u, p.Listen, p.Upstream, p.Realms)
	if !ok {
		return
	}
	p.PID = pid
	saveIssuerProxy(p)
}
