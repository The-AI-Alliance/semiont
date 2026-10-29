//go:build windows

package harness

import (
	"slices"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// OpenToOthers: what a path lets someone other than its owner do, or "" when
// that is nothing. Its owner here is the person running the test, with the
// system and the administrators, who read everything on the machine whatever
// a list says.
func OpenToOthers(t *testing.T, path string) string {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatal(err)
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	owners := []string{user.User.Sid.String(), system.String(), admins.String()}

	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("reading the access list of %s: %v", path, err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if dacl == nil {
		return "has no access list, which grants everyone everything"
	}
	granted := 0
	for i := uint16(0); i < dacl.AceCount; i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, uint32(i), &ace); err != nil {
			t.Fatal(err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			continue
		}
		granted++
		if sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String(); !slices.Contains(owners, sid) {
			return "grants access to " + sid
		}
	}
	if granted == 0 {
		return "grants nobody anything, its owner included"
	}
	return ""
}
