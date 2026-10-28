//go:build windows

package launcher

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var globalMemoryStatusEx = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")

// memoryStatusEx is kernel32's MEMORYSTATUSEX. Its first field is its own
// size, which the call checks.
type memoryStatusEx struct {
	length               uint32
	memoryLoad           uint32
	totalPhys            uint64
	availPhys            uint64
	totalPageFile        uint64
	availPageFile        uint64
	totalVirtual         uint64
	availVirtual         uint64
	availExtendedVirtual uint64
}

// hostMemGB reads the memory the machine has, from kernel32's
// GlobalMemoryStatusEx: it answers on a virtual machine too, where the
// firmware tables GetPhysicallyInstalledSystemMemory reads can be missing.
// 0 = unknown, which silences the preflight rather than warning on garbage.
func hostMemGB() float64 {
	status := memoryStatusEx{}
	status.length = uint32(unsafe.Sizeof(status))
	if ok, _, _ := globalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&status))); ok == 0 {
		return 0
	}
	return float64(status.totalPhys) / (1 << 30)
}
