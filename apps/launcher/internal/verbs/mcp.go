package verbs

// mcp.go — `semiont mcp`: the knowledge bases this machine signed in to, as
// MCP tools and resources, served over stdio to an AI application.
//
// Every tool acts as whoever `semiont login` signed in, through a session
// that renews itself (launcher.Sessions), one for each knowledge base. The
// tools are a curated set (mcp-tools.json); their schemas are the spec's
// (mcp_tools_gen.go). A call is held to its tool's input schema before
// anything is sent, and every fault in it is named in one refusal; nothing
// the caller did not state is sent. The protocol's own stdout carries the
// protocol and nothing else: everything else this process prints goes to
// stderr.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"golang.org/x/text/language"
	"golang.org/x/text/message"

	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/go/sdk"
)

const mcpUsage = `Usage: semiont mcp

Serve the knowledge bases this machine has signed in to (semiont login) to an
AI application, over MCP on stdin and stdout. The application runs it:

  claude mcp add semiont -- semiont mcp

Every tool acts as whoever signed in to the knowledge base it is for, through
a session that renews itself. The knowledge_bases tool lists them; every other
tool takes one by its key as kb. Logs go to stderr.

Options:
  --help   Show this help
`

func MCP(args []string) int {
	u := launcher.NewUI(false)
	for _, a := range args {
		switch a {
		case "--help", "-h":
			fmt.Print(mcpUsage)
			return 0
		default:
			u.Fail("Unknown argument: %s", a)
			return 1
		}
	}
	// The protocol is the one thing written to stdout: whatever else this
	// process prints is printed on stderr, where an MCP client logs it.
	protocol := os.Stdout
	os.Stdout = os.Stderr
	sessions := launcher.NewSessions(u, jobChannels...)
	defer sessions.Close()
	server, err := newMCPServer(sessions)
	if err != nil {
		u.Fail("semiont mcp: %v", err)
		return 1
	}
	if err := server.Run(context.Background(), &mcp.IOTransport{Reader: os.Stdin, Writer: protocol}); err != nil {
		u.Fail("semiont mcp: %v", err)
		return 1
	}
	return 0
}

// mcpTool is one tool, as mcp_tools_gen.go states it.
type mcpTool struct {
	Name        string          `json:"name"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Calls       []string        `json:"calls"`
	ReadOnly    bool            `json:"readOnly"`
	Destructive bool            `json:"destructive"`
	Input       json.RawMessage `json:"input"`
	Output      json.RawMessage `json:"output"`
}

// takesKb: a tool that calls an SDK method is for one knowledge base, which
// its `kb` names.
func (t mcpTool) takesKb() bool { return len(t.Calls) > 0 }

// mcpTools is mcp_tools_gen.go's document: every tool, and every SDK method
// no tool calls, with its reason.
type mcpTools struct {
	Tools   []mcpTool         `json:"tools"`
	LeftOut map[string]string `json:"leftOut"`
}

// mcpDocument is mcp_tools_gen.go's document, read once.
var mcpDocument = sync.OnceValues(func() (mcpTools, error) {
	var document mcpTools
	err := json.Unmarshal([]byte(mcpToolsDocument), &document)
	return document, err
})

// english is how a schema's refusal is worded.
var english = message.NewPrinter(language.English)

// mcpCall is one tool call, past its arguments' check: its arguments, the
// knowledge base it is for, and what it is answered through.
type mcpCall struct {
	args    json.RawMessage
	kb      string
	session *launcher.Session
	request *mcp.CallToolRequest
}

// client is the SDK client of the call's knowledge base.
func (c mcpCall) client() *launcher.VerbClient { return c.session.Client() }

// mcpAnswer is what a tool answers: its structured result, when its tool has
// an output schema, its words, and links to the resources it names.
type mcpAnswer struct {
	structured any
	text       string
	links      []*mcp.ResourceLink
}

// mcpHandler is one tool's work. arguments is the Go type its arguments are
// read into, which TestMCPToolsCensus holds to the tool's input schema.
type mcpHandler struct {
	arguments any
	run       func(ctx context.Context, call mcpCall) (mcpAnswer, error)
}

// handle is a tool's work over its arguments, read into A.
func handle[A any](run func(ctx context.Context, call mcpCall, args A) (mcpAnswer, error)) mcpHandler {
	var zero A
	return mcpHandler{arguments: zero, run: func(ctx context.Context, call mcpCall) (mcpAnswer, error) {
		var args A
		if err := json.Unmarshal(call.args, &args); err != nil {
			return mcpAnswer{}, fmt.Errorf("the arguments could not be read: %w", err)
		}
		return run(ctx, call, args)
	}}
}

// mcpRefusal is a call refused before anything was sent: an argument at
// fault, a knowledge base that cannot be reached. The model can correct it.
type mcpRefusal struct{ said string }

func (r *mcpRefusal) Error() string { return r.said }

func newMCPServer(sessions *launcher.Sessions) (*mcp.Server, error) {
	document, err := mcpDocument()
	if err != nil {
		return nil, fmt.Errorf("the tools' document cannot be read: %w", err)
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "semiont", Title: "Semiont", Version: launcher.BuildVersion}, &mcp.ServerOptions{
		Instructions: "Semiont knowledge bases: resources, the annotations on them, and the links between them. " +
			"knowledge_bases lists the ones this machine signed in to; every other tool takes one as kb.",
		SetCacheable: mcpCacheable,
	})
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	for _, tool := range document.Tools {
		handler, has := mcpHandlers[tool.Name]
		if !has {
			return nil, fmt.Errorf("the tool %s has no handler", tool.Name)
		}
		input, err := compileSchema(compiler, tool.Name, "input", tool.Input)
		if err != nil {
			return nil, err
		}
		var output *jsonschema.Schema
		if len(tool.Output) > 0 {
			if output, err = compileSchema(compiler, tool.Name, "output", tool.Output); err != nil {
				return nil, err
			}
		}
		server.AddTool(mcpListing(tool), mcpToolHandler(sessions, tool, handler, input, output))
	}
	addMCPResources(server, sessions)
	return server, nil
}

// mcpListing is how tools/list gives a tool.
func mcpListing(tool mcpTool) *mcp.Tool {
	listed := &mcp.Tool{
		Name:        tool.Name,
		Title:       tool.Title,
		Description: tool.Description,
		InputSchema: tool.Input,
		Annotations: &mcp.ToolAnnotations{Title: tool.Title, ReadOnlyHint: tool.ReadOnly},
	}
	if !tool.ReadOnly {
		destructive := tool.Destructive
		listed.Annotations.DestructiveHint = &destructive
	}
	if len(tool.Output) > 0 {
		listed.OutputSchema = tool.Output
	}
	return listed
}

func compileSchema(compiler *jsonschema.Compiler, tool, which string, text json.RawMessage) (*jsonschema.Schema, error) {
	document, err := jsonschema.UnmarshalJSON(strings.NewReader(string(text)))
	if err != nil {
		return nil, fmt.Errorf("%s's %s schema: %w", tool, which, err)
	}
	url := fmt.Sprintf("file:///mcp/%s/%s.json", tool, which)
	if err := compiler.AddResource(url, document); err != nil {
		return nil, fmt.Errorf("%s's %s schema: %w", tool, which, err)
	}
	schema, err := compiler.Compile(url)
	if err != nil {
		return nil, fmt.Errorf("%s's %s schema: %w", tool, which, err)
	}
	return schema, nil
}

// mcpToolHandler: one call of tool. Its arguments are held to the tool's
// input schema first, and refused with every fault named; then its knowledge
// base's session is taken (mcpSession), and its work run. A failure of the
// work is the tool's error, which the model is given, never a protocol error.
func mcpToolHandler(sessions *launcher.Sessions, tool mcpTool, handler mcpHandler, input, output *jsonschema.Schema) mcp.ToolHandler {
	return func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		args := request.Params.Arguments
		if len(args) == 0 || string(args) == "null" {
			args = json.RawMessage("{}")
		}
		if faults := argumentFaults(input, args); len(faults) > 0 {
			return mcpError("The arguments were refused, and nothing was sent:\n" + strings.Join(faults, "\n")), nil
		}
		call := mcpCall{args: args, request: request}
		if tool.takesKb() {
			var refused error
			if call.kb, refused = chosenKb(args); refused == nil {
				call.session, refused = mcpSession(sessions, call.kb)
			}
			if refused != nil {
				return mcpError(refused.Error()), nil
			}
		}
		answer, err := handler.run(ctx, call)
		if err != nil {
			return mcpError(mcpFailure(call, err)), nil
		}
		result := &mcp.CallToolResult{}
		if answer.structured != nil {
			written, err := json.Marshal(answer.structured)
			if err != nil {
				return nil, fmt.Errorf("%s's answer could not be written: %w", tool.Name, err)
			}
			if output != nil {
				if faults := argumentFaults(output, written); len(faults) > 0 {
					return mcpError(fmt.Sprintf("The knowledge base's answer does not match %s's output schema:\n%s", tool.Name, strings.Join(faults, "\n"))), nil
				}
			}
			result.StructuredContent = json.RawMessage(written)
			result.Content = []mcp.Content{&mcp.TextContent{Text: string(written)}}
		}
		if answer.text != "" {
			result.Content = append([]mcp.Content{&mcp.TextContent{Text: answer.text}}, result.Content...)
		}
		for _, link := range answer.links {
			result.Content = append(result.Content, link)
		}
		if result.Content == nil {
			result.Content = []mcp.Content{}
		}
		return result, nil
	}
}

func mcpError(said string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: said}}}
}

// mcpFailure is a failed call's words: a session that ended, with the
// command that restores it, or the failure as it came.
func mcpFailure(call mcpCall, err error) string {
	var refused *mcpRefusal
	if errors.As(err, &refused) {
		return refused.said
	}
	if call.session != nil {
		err = call.client().Refusal(err)
	}
	var rejected *launcher.SessionRejected
	if errors.As(err, &rejected) {
		return fmt.Sprintf("%s: %v. Sign in again: %s", call.kb, rejected, signInCommand(call.kb))
	}
	var failed *semiont.BusRequestError
	if errors.As(err, &failed) && failed.Failure != nil {
		return "The knowledge base refused it: " + failed.Message
	}
	return err.Error()
}

// signInCommand is the command that signs in to the knowledge base key names.
func signInCommand(key string) string {
	if repo, isCodespace := strings.CutPrefix(key, "codespace:"); isCodespace {
		return "semiont login --repo " + repo
	}
	return "semiont login"
}

// chosenKb is the knowledge base a call is for: the one its `kb` names, or,
// when it names none, the one this machine is signed in to, when there is
// exactly one. With none or several, the call is refused, naming them: the
// server does not pick one.
func chosenKb(args json.RawMessage) (string, error) {
	var named struct {
		Kb string `json:"kb"`
	}
	if err := json.Unmarshal(args, &named); err != nil {
		return "", err
	}
	if named.Kb != "" {
		return named.Kb, nil
	}
	known, err := launcher.SignedInKnowledgeBases()
	if err != nil {
		return "", err
	}
	switch len(known) {
	case 0:
		return "", &mcpRefusal{"No knowledge base is signed in on this machine. Sign in: semiont login"}
	case 1:
		return known[0].Key, nil
	}
	keys := make([]string, len(known))
	for i, kb := range known {
		keys[i] = "`" + kb.Key + "`"
	}
	return "", &mcpRefusal{"`kb` is required: this machine is signed in to " + strings.Join(keys, ", ") + ", and the call names none of them."}
}

// mcpSession is the session of the knowledge base key names, or why there
// is none, with the command that puts that right.
func mcpSession(sessions *launcher.Sessions, key string) (*launcher.Session, error) {
	s, err := sessions.Session(key)
	if err == nil {
		return s, nil
	}
	var unknown *launcher.UnknownKnowledgeBase
	var unreachable *launcher.CodespaceUnreachable
	var noGateway *launcher.NoGatewayRecorded
	var noSignIn *launcher.NoSignIn
	var rejected *launcher.SessionRejected
	switch {
	case errors.As(err, &unknown):
		return nil, &mcpRefusal{fmt.Sprintf("`kb`: %v. knowledge_bases lists the ones it did.", unknown)}
	case errors.As(err, &unreachable):
		_, command := unreachable.Remedy()
		return nil, &mcpRefusal{fmt.Sprintf("%v, so %s cannot be reached. %s", unreachable, key, command)}
	case errors.As(err, &noGateway):
		return nil, &mcpRefusal{fmt.Sprintf("%v, so %s cannot be reached. Start it: semiont start", noGateway, key)}
	case errors.As(err, &noSignIn):
		return nil, &mcpRefusal{fmt.Sprintf("No one is signed in to %s. Sign in: %s", key, signInCommand(key))}
	case errors.As(err, &rejected):
		return nil, &mcpRefusal{fmt.Sprintf("%s: %v. Sign in again: %s", key, rejected, signInCommand(key))}
	}
	return nil, err
}

// argumentFaults is each fault of instance against schema, one line each,
// all of them: an argument the schema does not name, one it requires and is
// missing, one of the wrong type or out of its bounds.
func argumentFaults(schema *jsonschema.Schema, instance json.RawMessage) []string {
	parsed, err := jsonschema.UnmarshalJSON(strings.NewReader(string(instance)))
	if err != nil {
		return []string{"- the arguments are not a JSON object: " + err.Error()}
	}
	invalid := schema.Validate(parsed)
	if invalid == nil {
		return nil
	}
	var refused *jsonschema.ValidationError
	if !errors.As(invalid, &refused) {
		return []string{"- " + invalid.Error()}
	}
	var faults []string
	add := func(location []string, said string) {
		at := "the arguments"
		if len(location) > 0 {
			at = "`" + strings.Join(location, ".") + "`"
		}
		faults = append(faults, fmt.Sprintf("- %s: %s", at, said))
	}
	var walk func(*jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		location := e.InstanceLocation
		switch k := e.ErrorKind.(type) {
		case *kind.AdditionalProperties:
			for _, name := range k.Properties {
				add(append(append([]string{}, location...), name), "is not an argument this takes")
			}
		case *kind.Required:
			for _, name := range k.Missing {
				add(append(append([]string{}, location...), name), "is required, and is missing")
			}
		case *kind.Type:
			add(location, fmt.Sprintf("wants %s, and is %s", strings.Join(k.Want, " or "), k.Got))
		case *kind.OneOf:
			if k.Subschemas == nil {
				add(location, "is none of the forms it can take")
			} else {
				add(location, "is more than one of the forms it can take, and must be exactly one")
			}
			return
		case *kind.Const, *kind.Enum, *kind.Pattern, *kind.Minimum, *kind.Maximum, *kind.ExclusiveMinimum,
			*kind.ExclusiveMaximum, *kind.MinLength, *kind.MaxLength, *kind.MinItems, *kind.MaxItems,
			*kind.MinProperties, *kind.MaxProperties, *kind.Not, *kind.MultipleOf, *kind.UniqueItems:
			add(location, e.ErrorKind.LocalizedString(english))
		}
		for _, cause := range e.Causes {
			walk(cause)
		}
	}
	walk(refused)
	if len(faults) == 0 {
		faults = []string{"- " + refused.Error()}
	}
	return faults
}

// mcpCacheable: what a knowledge base holds is the signed-in person's, so a
// cache of it is theirs alone.
func mcpCacheable(_ context.Context, request mcp.Request, c *mcp.Cacheable) {
	switch request.(type) {
	case *mcp.ListResourcesRequest, *mcp.ReadResourceRequest:
		c.CacheScope = "private"
	}
}
