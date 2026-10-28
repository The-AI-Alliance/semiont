package launcher

import (
	"encoding/csv"
	"strings"
)

// tasklistImage reads the image out of tasklist's CSV row for a process:
// "gh.exe","4242","Console","1","10,000 K". When no process matches, tasklist
// prints a sentence in the system's language in place of a row.
func tasklistImage(out, pid string) string {
	rows, err := csv.NewReader(strings.NewReader(out)).ReadAll()
	if err != nil {
		return ""
	}
	for _, row := range rows {
		if len(row) >= 2 && row[1] == pid {
			return strings.TrimSuffix(row[0], ".exe")
		}
	}
	return ""
}
