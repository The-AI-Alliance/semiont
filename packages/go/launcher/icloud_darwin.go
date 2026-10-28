//go:build darwin

package launcher

import "strings"

// desktopSyncsToICloud: Finder says Desktop and Documents sync to iCloud
// Drive (FXICloudDriveDesktop).
func desktopSyncsToICloud() bool {
	out, err := capture("defaults", "read", "com.apple.finder", "FXICloudDriveDesktop")
	return err == nil && strings.TrimSpace(out) == "1"
}
