//go:build !darwin

package launcher

// desktopSyncsToICloud: only macOS has the setting.
func desktopSyncsToICloud() bool { return false }
