// Command standin is the program harness.StandIn puts on a test's PATH under
// another program's name. What it does is in the file beside it, named for
// it with `.says` on the end.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/The-AI-Alliance/semiont/apps/launcher/internal/harness"
)

func main() {
	self, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "standin:", err)
		os.Exit(70)
	}
	raw, err := os.ReadFile(strings.TrimSuffix(self, ".exe") + ".says")
	if err != nil {
		fmt.Fprintln(os.Stderr, "standin:", err)
		os.Exit(70)
	}
	var says harness.Says
	if err := json.Unmarshal(raw, &says); err != nil {
		fmt.Fprintln(os.Stderr, "standin:", err)
		os.Exit(70)
	}
	args := os.Args[1:]
	if says.OnlyGiven != "" && !slices.Contains(args, says.OnlyGiven) {
		os.Exit(1)
	}
	if says.PrintsTheFile {
		if len(args) == 0 {
			os.Exit(1)
		}
		content, err := os.ReadFile(args[len(args)-1])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Stdout.Write(content)
	}
	if says.Out != "" {
		fmt.Println(says.Out)
	}
	if says.Waits {
		time.Sleep(time.Hour)
	}
	os.Exit(says.Exit)
}
