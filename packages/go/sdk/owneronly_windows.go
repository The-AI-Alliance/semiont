//go:build windows

package semiont

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	advapi32                          = syscall.NewLazyDLL("advapi32.dll")
	convertStringSecurityDescriptor   = advapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	convertSecurityDescriptorToString = advapi32.NewProc("ConvertSecurityDescriptorToStringSecurityDescriptorW")
	getNamedSecurityInfo              = advapi32.NewProc("GetNamedSecurityInfoW")
	getSecurityDescriptorDacl         = advapi32.NewProc("GetSecurityDescriptorDacl")
	setNamedSecurityInfo              = advapi32.NewProc("SetNamedSecurityInfoW")
)

const (
	sddlRevision1                    = 1
	seFileObject                     = 1
	daclSecurityInformation          = 0x00000004
	protectedDaclSecurityInformation = 0x80000000
)

// ownerOnlyDir keeps a directory, and everything created in it from then on,
// to its owner, with the access list the launcher gives one: the user this
// process runs as, the system and the administrators, each with full access,
// handed down to what is created in it, and nothing inherited from above. A
// mode keeps nobody out on Windows; the access list is what does. A directory
// that has the list already is left as it is: setting a list hands it down to
// everything beneath, which in a state home is no small walk. The two lists
// are compared as Windows writes each out, which names some users by an
// abbreviation (the built-in administrator is LA) rather than by their SID.
func ownerOnlyDir(dir string) error {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return fmt.Errorf("cannot name the current user: %w", err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return fmt.Errorf("cannot name the current user: %w", err)
	}
	owner, err := user.User.Sid.String()
	if err != nil {
		return fmt.Errorf("cannot name the current user: %w", err)
	}
	sddl, err := syscall.UTF16PtrFromString(fmt.Sprintf("D:PAI(A;OICI;FA;;;%s)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", owner))
	if err != nil {
		return err
	}
	var descriptor uintptr
	if made, _, err := convertStringSecurityDescriptor.Call(uintptr(unsafe.Pointer(sddl)), sddlRevision1, uintptr(unsafe.Pointer(&descriptor)), 0); made == 0 {
		return fmt.Errorf("cannot make the access list: %w", err)
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	list, err := sddlOf(descriptor)
	if err != nil {
		return err
	}
	name, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	if has, err := accessListAt(name); err != nil || has == list {
		return err
	}
	var present, defaulted int32
	var dacl uintptr
	if read, _, err := getSecurityDescriptorDacl.Call(descriptor, uintptr(unsafe.Pointer(&present)), uintptr(unsafe.Pointer(&dacl)), uintptr(unsafe.Pointer(&defaulted))); read == 0 {
		return fmt.Errorf("cannot read the access list: %w", err)
	}
	if failed, _, _ := setNamedSecurityInfo.Call(uintptr(unsafe.Pointer(name)), seFileObject, daclSecurityInformation|protectedDaclSecurityInformation, 0, 0, dacl, 0); failed != 0 {
		return fmt.Errorf("cannot keep %s to its owner: %w", dir, syscall.Errno(failed))
	}
	return nil
}

// accessListAt is the access list of what name names, as Windows writes it
// out (SDDL).
func accessListAt(name *uint16) (string, error) {
	var dacl, descriptor uintptr
	if failed, _, _ := getNamedSecurityInfo.Call(uintptr(unsafe.Pointer(name)), seFileObject, daclSecurityInformation, 0, 0, uintptr(unsafe.Pointer(&dacl)), 0, uintptr(unsafe.Pointer(&descriptor))); failed != 0 {
		return "", fmt.Errorf("cannot read the access list: %w", syscall.Errno(failed))
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	return sddlOf(descriptor)
}

// sddlOf is the access list a security descriptor holds, as Windows writes it
// out (SDDL).
func sddlOf(descriptor uintptr) (string, error) {
	var text *uint16
	if made, _, err := convertSecurityDescriptorToString.Call(descriptor, sddlRevision1, daclSecurityInformation, uintptr(unsafe.Pointer(&text)), 0); made == 0 {
		return "", fmt.Errorf("cannot write out the access list: %w", err)
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(unsafe.Pointer(text))))
	length := 0
	for *(*uint16)(unsafe.Add(unsafe.Pointer(text), 2*length)) != 0 {
		length++
	}
	return syscall.UTF16ToString(unsafe.Slice(text, length)), nil
}
