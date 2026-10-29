package main

// holders.go — what the system says holds a port and what a process runs,
// for the fake lsof, ps and tasklist when the scenario scripted no answer. The
// fake netstat reads Windows' own table for the same reason: a holder the fake
// made up names nothing, and a listener one test left behind then fails the
// next test without a word about where it came from.
//
// The PATH a scenario runs under is the shim, where lsof, ps and tasklist are
// this binary, so each real tool is named by its path.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
)

// systemListeners: the pids listening on TCP port, as this system reports
// them.
func systemListeners(port string) []string {
	switch runtime.GOOS {
	case "linux":
		return procListeners(port)
	case "darwin":
		return lsofListeners(port)
	}
	fmt.Fprintf(os.Stderr, "fakert lsof: the launcher asks netstat on %s, not lsof\n", runtime.GOOS)
	os.Exit(64)
	return nil
}

// procListeners reads Linux's socket tables: the inodes of the sockets
// listening on port, then the processes holding a descriptor of one. Linux
// runners need no lsof installed for it.
func procListeners(port string) []string {
	want, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fakert lsof: port %q: %v\n", port, err)
		os.Exit(64)
	}
	sockets := map[string]bool{}
	for _, table := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		b, err := os.ReadFile(table)
		if errors.Is(err, fs.ErrNotExist) {
			continue // a kernel without IPv6 has no tcp6 table, and no listener in one
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "fakert lsof: %v\n", err)
			os.Exit(64)
		}
		for _, row := range strings.Split(string(b), "\n")[1:] {
			// sl local_address rem_address st tx_queue:rx_queue tr:tm->when
			// retrnsmt uid timeout inode; st 0A is LISTEN.
			fields := strings.Fields(row)
			if len(fields) < 10 || fields[3] != "0A" {
				continue
			}
			_, hexPort, _ := strings.Cut(fields[1], ":")
			if p, err := strconv.ParseUint(hexPort, 16, 16); err == nil && p == want {
				sockets["socket:["+fields[9]+"]"] = true
			}
		}
	}
	if len(sockets) == 0 {
		return nil
	}
	procs, err := os.ReadDir("/proc")
	if err != nil {
		fmt.Fprintf(os.Stderr, "fakert lsof: %v\n", err)
		os.Exit(64)
	}
	var pids []string
	for _, proc := range procs {
		if _, err := strconv.Atoi(proc.Name()); err != nil {
			continue
		}
		fdDir := filepath.Join("/proc", proc.Name(), "fd")
		// A process that exited since the listing, or another user's, has no
		// descriptors to read here; neither is a holder this scenario made.
		fds, err := os.ReadDir(fdDir)
		if err != nil {
			continue
		}
		for _, fd := range fds {
			if target, err := os.Readlink(filepath.Join(fdDir, fd.Name())); err == nil && sockets[target] {
				pids = append(pids, proc.Name())
				break
			}
		}
	}
	return pids
}

// lsofListeners asks macOS's own lsof.
func lsofListeners(port string) []string {
	out, err := exec.Command("/usr/sbin/lsof", "-nP", "-iTCP:"+port, "-sTCP:LISTEN").Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		return nil // lsof exits 1 when nothing matches
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "fakert lsof: /usr/sbin/lsof: %v\n", err)
		os.Exit(64)
	}
	var pids []string
	for _, row := range strings.Split(string(out), "\n")[1:] {
		if fields := strings.Fields(row); len(fields) > 1 && !slices.Contains(pids, fields[1]) {
			pids = append(pids, fields[1])
		}
	}
	return pids
}

// systemProcessName: what pid runs, as this system's ps reports it; false
// when no process has that pid.
func systemProcessName(pid string) (string, bool) {
	switch runtime.GOOS {
	case "linux":
		b, err := os.ReadFile(filepath.Join("/proc", pid, "comm"))
		if errors.Is(err, fs.ErrNotExist) {
			return "", false
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "fakert ps: %v\n", err)
			os.Exit(64)
		}
		return strings.TrimSpace(string(b)), true
	case "darwin":
		out, err := exec.Command("/bin/ps", "-p", pid, "-o", "comm=").Output()
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 1 {
			return "", false
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "fakert ps: /bin/ps: %v\n", err)
			os.Exit(64)
		}
		return strings.TrimSpace(string(out)), true
	}
	fmt.Fprintf(os.Stderr, "fakert ps: the launcher asks tasklist on %s, not ps\n", runtime.GOOS)
	os.Exit(64)
	return "", false
}

// systemTasklist answers with Windows' own tasklist, given the same arguments.
func systemTasklist(args []string) {
	out, err := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "tasklist.exe"), args...).Output()
	if err != nil {
		fmt.Fprintf(os.Stderr, "fakert tasklist: %v\n", err)
		os.Exit(64)
	}
	os.Stdout.Write(out)
}
