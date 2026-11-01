// Code generated from specs/src/sign-in-store/owner-only.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-sign-in-go.mjs
// The Go SDK (packages/go/sdk/owneronly_gen.go) generates its own from the same file.

package launcher

import "os"

// ownerOnlyMode: The directory's mode, in octal, on a system that has modes:
// its owner reads, writes and enters it, and nobody else does.
const ownerOnlyMode os.FileMode = 0o700

// ownerOnlyDirAccessList: The directory's access list on Windows, where a
// mode keeps nobody out, in SDDL, with `owner` where the SID of the user the
// writer runs as goes (its process token's user): full access for that user,
// the system and the administrators, and nobody else. It is handed down to
// everything made in the directory, and protected, so nothing is inherited
// from above.
func ownerOnlyDirAccessList(owner string) string {
	return "D:PAI(A;OICI;FA;;;" + owner + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
}

// ownerOnlyFileAccessList: The same list as a file is given it: each entry
// hands nothing down, since a file has nothing beneath it.
func ownerOnlyFileAccessList(owner string) string {
	return "D:PAI(A;;FA;;;" + owner + ")(A;;FA;;;SY)(A;;FA;;;BA)"
}
