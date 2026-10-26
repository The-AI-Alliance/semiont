// Command semiont-go-wire-driver is the Go SDK's wire driver: the program the
// SDK conformance suite talks to in the Go SDK's place
// (tests/conformance/sdk/README.md, § The driver protocol).
//
// It writes {"ready": true}, then answers each operation it reads, one JSON
// object a line, and exits 0 when its stdin ends. The Go SDK has no
// transport yet, so every operation is answered as one this driver has not:
// {"id": …, "unsupported": true}, at once, before the next is read. The suite
// holds the Go SDK exempt from each wire case until a phase of the Go SDK's
// work builds what the case asks (tests/conformance/harness/paths.ts), and an
// exempt case passes only while this answer stands.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	out := json.NewEncoder(os.Stdout)
	if err := out.Encode(map[string]bool{"ready": true}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	in := bufio.NewScanner(os.Stdin)
	// An upload carries its bytes in its line, as base64.
	in.Buffer(make([]byte, 0, 1<<20), 64<<20)
	for in.Scan() {
		var operation struct {
			ID json.RawMessage `json:"id"`
			Op string          `json:"op"`
		}
		if err := json.Unmarshal(in.Bytes(), &operation); err != nil || operation.ID == nil {
			fmt.Fprintf(os.Stderr, "a line that is no operation: %s\n", in.Bytes())
			continue
		}
		answer := struct {
			ID          json.RawMessage `json:"id"`
			Unsupported bool            `json:"unsupported"`
		}{operation.ID, true}
		if err := out.Encode(answer); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	if err := in.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
