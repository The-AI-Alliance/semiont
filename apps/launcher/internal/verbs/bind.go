package verbs

// bind.go — `semiont bind`: resolve a linking annotation to a target
// resource by adding a SpecificResource body item (purpose: linking). One
// bus operation, bind:update-body, whose payload is a list of body
// operations — so unbinding is the same call with op "remove".

import (
	"context"
	"fmt"
	"strings"

	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

const bindIDs = "semiont bind [options] -- <resourceId> <annotationId> <targetResourceId>"

const bindUsage = `Usage: semiont bind <resourceId> <annotationId> <targetResourceId>
       semiont bind <resourceId> <annotationId> --unbind <targetResourceId>
       semiont bind --resource <id> --annotation <id> --target <id>

Point a linking annotation at the resource it refers to.

Options:
  --resource <id>      The resource the annotation is on (bare: first)
  --annotation <id>    The linking annotation (bare: second)
  --target <id>        The resource it refers to (bare: third)
  --unbind <id>        Remove that target instead of adding it
  --json               Raw JSON reply
  --repo <owner/name>  Target a codespace stack (default: the local stack)
  --runtime <rt>       Target the local stack explicitly
  --help               Show this help

` + idsOrder + `

` + idsNote + `
  ` + bindIDs + `

Requires a session:  semiont login
`

func Bind(args []string) int {
	u := launcher.NewUI(false)
	var positional []string
	var resourceID, annotationID, target, repo string
	unbind, asJSON, wantLocal := false, false, false

options:
	for i := 0; i < len(args); i++ {
		a := args[i]
		val := func() (string, bool) {
			if i+1 >= len(args) {
				u.Fail("Missing value for %s", a)
				return "", false
			}
			i++
			return args[i], true
		}
		var ok bool
		switch a {
		case "--resource":
			ok = idValue(u, "resource", val, &resourceID)
		case "--annotation":
			ok = idValue(u, "annotation", val, &annotationID)
		case "--target":
			ok = idValue(u, "target", val, &target)
		case "--unbind":
			unbind, ok = true, idValue(u, "target", val, &target)
		case "--repo":
			repo, ok = val()
		case "--runtime":
			_, ok = val()
			wantLocal = true
		case "--json":
			asJSON, ok = true, true
		case "--":
			// Every word after it is an id, whatever it begins with.
			positional = append(positional, args[i+1:]...)
			break options
		case "--help", "-h":
			fmt.Print(bindUsage)
			return 0
		default:
			if strings.HasPrefix(a, "-") {
				return unknownArgument(u, a, bindIDs)
			}
			positional = append(positional, a)
			ok = true
		}
		if !ok {
			return 1
		}
	}

	if !fillIDs(u, bindIDs, positional, &resourceID, &annotationID, &target) {
		return 1
	}
	if resourceID == "" || annotationID == "" || target == "" {
		fmt.Print(bindUsage)
		return 1
	}
	op := "add"
	if unbind {
		op = "remove"
	}

	t, ok := launcher.VerbSession(u, "bind", repo, wantLocal)
	if !ok {
		return 1
	}
	cli := t.Transport()

	var item semiont.AnnotationBody
	purpose := semiont.BodyPurpose("linking")
	// No `type` literal: AnnotationBody's discriminator means the generated
	// FromSpecificResource stamps it (see mark.go).
	if err := item.FromSpecificResource(semiont.SpecificResource{
		Source: target, Purpose: &purpose,
	}); err != nil {
		u.Fail("could not build the body item: %v", err)
		return 1
	}
	cmd := semiont.BindUpdateBodyCommand{
		ResourceId:   resourceID,
		AnnotationId: annotationID,
	}
	cmd.Operations = []semiont.BindBodyOperation{{
		Op:   semiont.BindBodyOperationOp(op),
		Item: &item,
	}}
	reply, err := cli.Request(context.Background(), "bind:update-body", cmd, nil)
	if err != nil {
		return busFail(u, "bind", err)
	}
	if asJSON {
		fmt.Println(string(reply))
		return 0
	}
	if unbind {
		u.Ok("Unbound %s from %s", annotationID, target)
	} else {
		u.Ok("Bound %s → %s", annotationID, target)
	}
	return 0
}
