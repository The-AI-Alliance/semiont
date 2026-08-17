package launcher

// mark.go — `semiont mark`: create and delete annotations over the bus.
// Selectors and bodies follow the W3C Web Annotation shapes the OpenAPI
// schemas define (CreateAnnotationRequest: target + motivation + body);
// this file only assembles them from flags.

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

const markUsage = `Usage: semiont mark <resourceId> [selector] [body] [options]
       semiont mark --delete <annotationId> --resource <resourceId>

Annotate a resource. A selector says WHERE, a body says WHAT.

Selector (one of):
  --quote <text>        Select this exact text (add --prefix/--suffix for context)
  --start <n> --end <n> Select by character position
  (none)                Annotate the whole resource

Body:
  --body-text <text>    A textual note
  --link <resourceId>   A link to another resource (motivation: linking)
  --entity-type <name>  Tag with an entity type (repeatable)

Options:
  --motivation <m>      Override the motivation (default: inferred from the body)
  --delete <id>         Delete an annotation instead (needs --resource)
  --resource <id>       The resource a deleted annotation belongs to
  --json                Raw JSON reply
  --repo <owner/name>   Target a codespace stack (default: the local stack)
  --runtime <rt>        Target the local stack explicitly
  --help                Show this help

Requires a session:  semiont login --email <address>
`

func Mark(args []string) int {
	u := newUI(false)
	var resourceID, quote, prefix, suffix, bodyText, link, motivation, deleteID, resourceFlag, repo string
	var entityTypes []string
	start, end := -1, -1
	asJSON, wantLocal := false, false

	for i := 0; i < len(args); i++ {
		a := args[i]
		val := func() (string, bool) {
			if i+1 >= len(args) {
				u.fail("Missing value for %s", a)
				return "", false
			}
			i++
			return args[i], true
		}
		num := func() (int, bool) {
			v, ok := val()
			if !ok {
				return 0, false
			}
			n, err := strconv.Atoi(v)
			if err != nil || n < 0 {
				u.fail("%s wants a non-negative number, got %q", a, v)
				return 0, false
			}
			return n, true
		}
		var ok bool
		switch a {
		case "--quote":
			quote, ok = val()
		case "--prefix":
			prefix, ok = val()
		case "--suffix":
			suffix, ok = val()
		case "--body-text":
			bodyText, ok = val()
		case "--link":
			link, ok = val()
		case "--motivation":
			motivation, ok = val()
		case "--delete":
			deleteID, ok = val()
		case "--resource":
			resourceFlag, ok = val()
		case "--repo":
			repo, ok = val()
		case "--entity-type":
			var v string
			v, ok = val()
			if ok {
				entityTypes = append(entityTypes, v)
			}
		case "--start":
			start, ok = num()
		case "--end":
			end, ok = num()
		case "--runtime":
			_, ok = val()
			wantLocal = true
		case "--json":
			asJSON, ok = true, true
		case "--help", "-h":
			fmt.Print(markUsage)
			return 0
		default:
			if strings.HasPrefix(a, "-") {
				u.fail("Unknown argument: %s", a)
				return 1
			}
			if resourceID != "" {
				u.fail("Only one resourceId may be given (got %q and %q).", resourceID, a)
				return 1
			}
			resourceID, ok = a, true
		}
		if !ok {
			return 1
		}
	}

	if deleteID != "" {
		if resourceFlag == "" {
			u.fail("--delete needs --resource <resourceId> (an annotation is addressed within its resource).")
			return 1
		}
	} else if resourceID == "" {
		fmt.Print(markUsage)
		return 1
	}
	if (start >= 0) != (end >= 0) {
		u.fail("--start and --end go together.")
		return 1
	}
	if quote != "" && start >= 0 {
		u.fail("--quote and --start/--end are two ways to say the same thing; pick one.")
		return 1
	}

	t, ok := verbSession(u, "mark", repo, wantLocal)
	if !ok {
		return 1
	}
	cli := newTransport(t.base, t.token)

	if deleteID != "" {
		_, err := cli.Request(context.Background(), "mark:delete",
			semiont.MarkDeleteCommand{AnnotationId: deleteID, ResourceId: &resourceFlag}, nil)
		if err != nil {
			return busFail(u, "mark --delete", err)
		}
		u.ok("Deleted annotation %s", deleteID)
		return 0
	}

	// Motivation follows the body when the caller does not say otherwise —
	// the W3C vocabulary the backend validates against.
	if motivation == "" {
		switch {
		case link != "":
			motivation = "linking"
		case bodyText != "":
			motivation = "commenting"
		case len(entityTypes) > 0:
			motivation = "tagging"
		default:
			motivation = "highlighting"
		}
	}

	// Built with the generated types and their union constructors: a
	// selector or body assembled as a bare map is exactly how a wrong field
	// name reaches the backend unnoticed.
	target := semiont.AnnotationTarget{Source: resourceID}
	switch {
	case quote != "":
		sel := semiont.TextQuoteSelector{Type: "TextQuoteSelector", Exact: quote}
		if prefix != "" {
			sel.Prefix = &prefix
		}
		if suffix != "" {
			sel.Suffix = &suffix
		}
		var u semiont.AnnotationTarget_Selector
		if err := u.FromTextQuoteSelector(sel); err != nil {
			return markBuildFail(err)
		}
		target.Selector = &u
	case start >= 0:
		var u semiont.AnnotationTarget_Selector
		if err := u.FromTextPositionSelector(semiont.TextPositionSelector{
			Type: "TextPositionSelector", Start: float32(start), End: float32(end),
		}); err != nil {
			return markBuildFail(err)
		}
		target.Selector = &u
	}

	// The `type` discriminant is NOT set here: AnnotationBody declares one in
	// the schema, so the generated From* stamps it on the way in. A literal
	// beside these fields would be overwritten with the same value — and would
	// quietly absorb a typo rather than failing.
	var bodies []semiont.AnnotationBody
	if bodyText != "" {
		var b semiont.AnnotationBody
		purpose := semiont.BodyPurpose("commenting")
		if err := b.FromTextualBody(semiont.TextualBody{
			Value: bodyText, Purpose: &purpose,
		}); err != nil {
			return markBuildFail(err)
		}
		bodies = append(bodies, b)
	}
	if link != "" {
		var b semiont.AnnotationBody
		purpose := semiont.BodyPurpose("linking")
		if err := b.FromSpecificResource(semiont.SpecificResource{
			Source: link, Purpose: &purpose,
		}); err != nil {
			return markBuildFail(err)
		}
		bodies = append(bodies, b)
	}
	for _, et := range entityTypes {
		var b semiont.AnnotationBody
		purpose := semiont.BodyPurpose("tagging")
		if err := b.FromTextualBody(semiont.TextualBody{
			Type: "TextualBody", Value: et, Purpose: &purpose,
		}); err != nil {
			return markBuildFail(err)
		}
		bodies = append(bodies, b)
	}

	request := semiont.CreateAnnotationRequest{
		Target:     target,
		Motivation: semiont.Motivation(motivation),
	}
	// The body is a union of "one body" or "a list of bodies" — the schema
	// models both, so use the list form only when there is more than one.
	if len(bodies) == 1 {
		var body semiont.CreateAnnotationRequest_Body
		if err := body.FromAnnotationBody(bodies[0]); err != nil {
			return markBuildFail(err)
		}
		request.Body = &body
	} else if len(bodies) > 1 {
		var body semiont.CreateAnnotationRequest_Body
		if err := body.FromCreateAnnotationRequestBody1(bodies); err != nil {
			return markBuildFail(err)
		}
		request.Body = &body
	}

	reply, err := cli.Request(context.Background(), "mark:create-request",
		semiont.MarkCreateRequest{ResourceId: resourceID, Request: request}, nil)
	if err != nil {
		return busFail(u, "mark", err)
	}
	if asJSON {
		fmt.Println(string(reply))
		return 0
	}
	var ok2 semiont.MarkCreateOk
	if json.Unmarshal(reply, &ok2) != nil {
		u.ok("Marked %s %s", resourceID, u.dim("("+motivation+")"))
		return 0
	}
	id := ok2.Response.AnnotationId
	if id == "" {
		u.ok("Marked %s %s", resourceID, u.dim("("+motivation+")"))
		return 0
	}
	u.ok("Marked %s → %s %s", resourceID, id, u.dim("("+motivation+")"))
	return 0
}

// markBuildFail: a union constructor only fails on a programming error here
// (the value cannot be encoded), so say so plainly rather than dressing it
// as a backend problem.
func markBuildFail(err error) int {
	newUI(false).fail("could not build the annotation: %v", err)
	return 1
}
