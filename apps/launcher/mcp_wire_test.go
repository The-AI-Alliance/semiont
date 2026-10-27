package main_test

import (
	"context"
	"encoding/json"
	"os/exec"
	"slices"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The built binary is an MCP server over stdio, for a client of each era: a
// 2026-07-28 client, which asks server/discover and is served without a
// session, and a 2025-11-25 client, which initializes one. Each lists the
// tools and calls one. Nothing is signed in here, so knowledge_bases lists
// none.
func TestMCPServesAClientOfEachEraOverStdio(t *testing.T) {
	s := newScenario(t)
	for _, era := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(era, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			cmd := exec.Command(launcherBin, "mcp")
			cmd.Env = s.env()
			cmd.Dir = s.kb
			client := mcp.NewClient(&mcp.Implementation{Name: "wire-test", Version: "0"}, nil)
			cs, err := client.Connect(ctx, &mcp.CommandTransport{Command: cmd}, &mcp.ClientSessionOptions{ProtocolVersion: era})
			if err != nil {
				t.Fatalf("connecting as a %s client: %v", era, err)
			}
			defer func() { _ = cs.Close() }()
			if negotiated := cs.InitializeResult().ProtocolVersion; negotiated != era {
				t.Errorf("a %s client was served %s", era, negotiated)
			}

			listed, err := cs.ListTools(ctx, nil)
			if err != nil {
				t.Fatalf("tools/list: %v", err)
			}
			var names []string
			for _, tool := range listed.Tools {
				names = append(names, tool.Name)
			}
			for _, want := range []string{"knowledge_bases", "browse_resource", "mark_delegate", "job_status", "beckon_attention"} {
				if !slices.Contains(names, want) {
					t.Errorf("tools/list gives no %s: %v", want, names)
				}
			}

			result, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "knowledge_bases", Arguments: map[string]any{}})
			if err != nil {
				t.Fatalf("knowledge_bases: %v", err)
			}
			if result.IsError {
				t.Fatalf("knowledge_bases refused: %v", result.Content)
			}
			written, _ := json.Marshal(result.StructuredContent)
			var answer struct {
				KnowledgeBases []json.RawMessage `json:"knowledgeBases"`
			}
			if err := json.Unmarshal(written, &answer); err != nil || answer.KnowledgeBases == nil || len(answer.KnowledgeBases) != 0 {
				t.Errorf("knowledge_bases with nothing signed in answered %s", written)
			}
		})
	}
}
