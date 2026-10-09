package verbs

// mark.go — `semiont mark`: create and delete annotations over the bus.
// Selectors and bodies follow the W3C Web Annotation shapes the OpenAPI
// schemas define (CreateAnnotationRequest: target + motivation + body);
// this file only assembles them from flags. `--delegate` is the other form:
// the stack's worker reads the resource and annotates it, as a job this verb
// creates and follows (job.go).

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"

	launcher "github.com/The-AI-Alliance/semiont/apps/launcher/internal/launcher"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

const markUsage = `Usage: semiont mark <resourceId> [selector] [body] [options]
       semiont mark --delete <annotationId> --resource <resourceId>

Annotate a resource. A selector says WHERE, a body says WHAT.

Selector (one of):
  --quote <text>        Select this exact text (add --prefix/--suffix for context)
  --start <n> --end <n> Select by position: offsets in Unicode code points from
                        the start of the resource's text, from <start> up to <end>
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

Requires a session:  semiont login
Annotation by the stack: semiont mark --delegate --help
`

const markDelegateUsage = `Usage: semiont mark --delegate <resourceId> --motivation <m> [options]

Have the stack annotate a resource: its worker reads the whole resource and
writes the annotations.

Motivation (required):
  highlighting          Mark the passages that matter
  commenting            Write comments on passages
  assessing             Write assessments of passages
  linking               Mark references to entities (needs --entity-type)
  tagging               Tag passages by a schema's categories (needs --schema, --category)

Options (each motivation's job takes its own, and refuses another's, saying
which it takes):
  --instructions <text>    What the pass should attend to
  --density <n>            Aim for about n annotations per 2000 words
  --tone <t>               commenting, the voice of the comments: scholarly |
                           explanatory | conversational | technical
                           assessing, the stance of the assessments: analytical |
                           critical | balanced | constructive
  --language <tag>         BCP-47 language the annotations are written in
  --source-language <tag>  BCP-47 language of the resource
  --entity-type <name>     linking: an entity type to look for (repeatable;
                           semiont browse --entity-types lists them)
  --descriptive            linking: also mark descriptions ("the senator"), not
                           only names
  --schema <id>            tagging: the tag schema (semiont browse --tag-schemas
                           lists them)
  --category <name>        tagging: a category of that schema (repeatable)
  --json                   Raw JSON completion event
  --repo <owner/name>      Target a codespace stack (default: the local stack)
  --runtime <rt>           Target the local stack explicitly

Requires a session:  semiont login
`

// entityTypeFlag: the one flag both forms of mark take. By hand each names a
// tag's body; delegated, they are the entity types a linking job looks for.
const entityTypeFlag = "--entity-type"

// markJobFlags: the flag that gives each parameter of a delegated mark's job.
// Which of them a motivation's job takes is its generated type's to say
// (markJob), and TestEveryMarkJobParameterHasItsFlag holds this table to the
// five of them.
var markJobFlags = jobFlags{
	"--instructions":    {"instructions", flagText},
	"--density":         {"density", flagPositive},
	"--tone":            {"tone", flagText},
	"--language":        {"language", flagText},
	"--source-language": {"sourceLanguage", flagText},
	entityTypeFlag:      {"entityTypes", flagList},
	"--descriptive":     {"includeDescriptiveReferences", flagSet},
	"--schema":          {"schemaId", flagText},
	"--category":        {"categories", flagList},
}

// markJob: the job:create a delegated mark sends: a `mark` job on the
// resource, its parameters the chosen motivation's generated type holding what
// the flags gave.
func markJob(resourceID string, motivation semiont.Motivation, given map[string]any) (semiont.JobCreateCommand, error) {
	var create semiont.JobCreateCommand
	if !motivation.Valid() {
		return create, fmt.Errorf("--motivation wants a motivation a mark can be delegated for, got %q", motivation)
	}
	described := map[string]any{"motivation": motivation}
	for param, value := range given {
		described[param] = value
	}
	// The union says which generated type holds this motivation's parameters.
	var params semiont.MarkJobParams
	written, err := json.Marshal(described)
	if err == nil {
		err = params.UnmarshalJSON(written)
	}
	if err != nil {
		return create, err
	}
	generated, err := params.ValueByDiscriminator()
	if err != nil {
		return create, err
	}
	held := reflect.New(reflect.TypeOf(generated))
	if err := jobParams(described, markJobFlags, held.Interface(), string(motivation)); err != nil {
		return create, err
	}
	// What is sent is what that type writes.
	if written, err = json.Marshal(held.Interface()); err == nil {
		err = params.UnmarshalJSON(written)
	}
	if err != nil {
		return create, err
	}
	err = create.FromMarkJobCreateCommand(semiont.MarkJobCreateCommand{ResourceId: resourceID, Params: params})
	return create, err
}

func Mark(args []string) int {
	u := launcher.NewUI(false)
	var resourceID, quote, prefix, suffix, bodyText, link, motivation, deleteID, resourceFlag, repo string
	start, end := -1, -1
	asJSON, wantLocal := false, false
	delegate := false
	// given: what the job flags gave, by the name of the parameter each gives.
	given := map[string]any{}
	// The flags that belong to one form of mark only, as they were typed, so
	// the other form can refuse them by name.
	var handOnly, delegateOnly []string

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
		num := func() (int, bool) {
			v, ok := val()
			if !ok {
				return 0, false
			}
			n, err := strconv.Atoi(v)
			if err != nil || n < 0 {
				u.Fail("%s wants a non-negative number, got %q", a, v)
				return 0, false
			}
			return n, true
		}
		if taken, ok := markJobFlags.take(u, a, val, given); taken {
			if !ok {
				return 1
			}
			if a != entityTypeFlag {
				delegateOnly = append(delegateOnly, a)
			}
			continue
		}
		var ok bool
		switch a {
		case "--quote", "--prefix", "--suffix", "--body-text", "--link", "--delete", "--resource", "--start", "--end":
			handOnly = append(handOnly, a)
		}
		switch a {
		case "--delegate":
			delegate, ok = true, true
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
			if delegate {
				fmt.Print(markDelegateUsage)
			} else {
				fmt.Print(markUsage)
			}
			return 0
		default:
			if strings.HasPrefix(a, "-") {
				u.Fail("Unknown argument: %s", a)
				return 1
			}
			if resourceID != "" {
				u.Fail("Only one resourceId may be given (got %q and %q).", resourceID, a)
				return 1
			}
			resourceID, ok = a, true
		}
		if !ok {
			return 1
		}
	}

	if delegate {
		if len(handOnly) > 0 {
			u.Fail("%s says where or what to annotate by hand; with --delegate the stack decides both.", handOnly[0])
			return 1
		}
		if resourceID == "" {
			u.Fail("--delegate needs the resource to annotate.")
			fmt.Fprintln(os.Stderr, "  semiont mark --delegate --help")
			return 1
		}
		if motivation == "" {
			u.Fail("--delegate needs --motivation.")
			fmt.Fprintln(os.Stderr, "  semiont mark --delegate --help")
			return 1
		}
		chosen := semiont.Motivation(motivation)
		command, err := markJob(resourceID, chosen, given)
		if err != nil {
			u.Fail("%v", err)
			fmt.Fprintln(os.Stderr, "  semiont mark --delegate --help")
			return 1
		}
		t, ok := launcher.VerbSession(u, "mark", repo, wantLocal)
		if !ok {
			return 1
		}
		return runMarkDelegate(u, t, command, resourceID, chosen, asJSON)
	}
	if len(delegateOnly) > 0 {
		u.Fail("%s belongs to --delegate, where the stack does the annotating.", delegateOnly[0])
		fmt.Fprintln(os.Stderr, "  semiont mark --delegate --help")
		return 1
	}

	if deleteID != "" {
		if resourceFlag == "" {
			u.Fail("--delete needs --resource <resourceId> (an annotation is addressed within its resource).")
			return 1
		}
	} else if resourceID == "" {
		fmt.Print(markUsage)
		return 1
	}
	entityTypes, _ := given[markJobFlags[entityTypeFlag].param].([]string)
	if (start >= 0) != (end >= 0) {
		u.Fail("--start and --end go together.")
		return 1
	}
	if quote != "" && start >= 0 {
		u.Fail("--quote and --start/--end are two ways to say the same thing; pick one.")
		return 1
	}

	t, ok := launcher.VerbSession(u, "mark", repo, wantLocal)
	if !ok {
		return 1
	}
	cli := t.Transport()

	if deleteID != "" {
		_, err := cli.Request(context.Background(), "mark:delete",
			semiont.MarkDeleteCommand{AnnotationId: deleteID, ResourceId: &resourceFlag}, nil)
		if err != nil {
			return busFail(u, "mark --delete", err)
		}
		u.Ok("Deleted annotation %s", deleteID)
		return 0
	}

	// Motivation follows the body when the caller does not say otherwise —
	// the W3C vocabulary the gateway validates against.
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
	// name reaches the gateway unnoticed.
	//
	// The `type` discriminant is NOT set on a selector or a body: Selector and
	// AnnotationBody each declare one in the schema, so the generated From*
	// stamps it on the way in. A literal beside these fields would be
	// overwritten with the same value — and would quietly absorb a typo
	// rather than failing.
	target := semiont.AnnotationTarget{Source: resourceID}
	var one semiont.Selector
	switch {
	case quote != "":
		sel := semiont.TextQuoteSelector{Exact: quote}
		if prefix != "" {
			sel.Prefix = &prefix
		}
		if suffix != "" {
			sel.Suffix = &suffix
		}
		if err := one.FromTextQuoteSelector(sel); err != nil {
			return markBuildFail(err)
		}
	case start >= 0:
		if err := one.FromTextPositionSelector(semiont.TextPositionSelector{
			Start: start, End: end,
		}); err != nil {
			return markBuildFail(err)
		}
	}
	if quote != "" || start >= 0 {
		// A selector is one selector or a list of them: this is one.
		var selector semiont.AnnotationSelector
		if err := selector.FromSelector(one); err != nil {
			return markBuildFail(err)
		}
		target.Selector = &selector
	}

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
			Value: et, Purpose: &purpose,
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
		var body semiont.AnnotationBodies
		if err := body.FromAnnotationBody(bodies[0]); err != nil {
			return markBuildFail(err)
		}
		request.Body = &body
	} else if len(bodies) > 1 {
		var body semiont.AnnotationBodies
		if err := body.FromAnnotationBodies1(bodies); err != nil {
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
		u.Ok("Marked %s %s", resourceID, u.Dim("("+motivation+")"))
		return 0
	}
	id := ok2.Response.AnnotationId
	if id == "" {
		u.Ok("Marked %s %s", resourceID, u.Dim("("+motivation+")"))
		return 0
	}
	u.Ok("Marked %s → %s %s", resourceID, id, u.Dim("("+motivation+")"))
	return 0
}

// markJobResults: what a `mark` job reports.
var markJobResults = resultMembers[semiont.MarkJobResult]{
	{semiont.JobDetectionResult{}, "a mark job's counts"},
	declinedResult,
}

// markNouns: what the terminal calls an annotation of each motivation, in the
// singular. A mark job's last progress line ("Created 3 highlights") and the
// line it ends with ("created 3 highlights (4 found)") both word the job's
// motivation from here. TestEveryMotivationHasItsNoun holds the table to the
// spec's motivations.
var markNouns = map[semiont.Motivation]string{
	semiont.MotivationHighlighting: "highlight",
	semiont.MotivationCommenting:   "comment",
	semiont.MotivationAssessing:    "assessment",
	semiont.MotivationLinking:      "reference",
	semiont.MotivationTagging:      "tag",
}

// runMarkDelegate creates the annotation job and follows it to its end.
func runMarkDelegate(u *launcher.UI, t launcher.VerbTarget, command semiont.JobCreateCommand, resourceID string, motivation semiont.Motivation, asJSON bool) int {
	job := delegatedJob[semiont.MarkJobCompleteCommand]{
		verb: "mark --delegate", doing: "Annotating " + resourceID, note: string(motivation), failed: "Annotation",
		check:  "semiont browse " + resourceID + " --annotations",
		create: command,
		jobOf:  func(done semiont.MarkJobCompleteCommand) semiont.JobId { return done.JobId },
	}
	done, raw, ok := job.run(u, t.Transport())
	if !ok {
		return 1
	}
	result, err := jobResult(done.Result, markJobResults)
	if err != nil {
		return job.resultFail(u, done.JobId, err)
	}
	declined, isDecline := result.(semiont.JobDeclinedResult)
	if asJSON {
		fmt.Println(string(raw))
		// The exit code is a property of the outcome, not of the output
		// format.
		if isDecline {
			return 1
		}
		return 0
	}
	if isDecline {
		// Not a failure: the job ran and found nothing it could read. Non-zero
		// all the same, since nothing downstream of a `mark --delegate && ...`
		// has annotations to work with.
		u.Fail("Declined (%s): %s", declined.Reason, declineText(declined.Reason))
		fmt.Fprintln(os.Stderr, "  Nothing was annotated.")
		return 1
	}
	if detected, ok := result.(semiont.JobDetectionResult); ok {
		u.Ok("Marked %s: %s", resourceID, markedText(motivation, detected))
		return 0
	}
	u.Ok("Marked %s %s", resourceID, u.Dim("("+string(motivation)+")"))
	return 0
}

// markedText: what a completed mark job did, in the words of its last
// progress line: "created 4 references (5 found, 1 error)". A tagging job's
// count per category follows: ": issue 2, rule 4".
func markedText(motivation semiont.Motivation, result semiont.JobDetectionResult) string {
	text := fmt.Sprintf("created %s (%d found", plural(result.Persisted, markNouns[motivation]), result.Found)
	if result.Errors != nil {
		text += ", " + plural(*result.Errors, "error")
	}
	text += ")"
	if result.ByCategory == nil {
		return text
	}
	var categories []string
	for _, name := range sortedNames(*result.ByCategory) {
		categories = append(categories, fmt.Sprintf("%s %d", name, (*result.ByCategory)[name]))
	}
	if len(categories) > 0 {
		text += ": " + strings.Join(categories, ", ")
	}
	return text
}

// markBuildFail: a union constructor only fails on a programming error here
// (the value cannot be encoded), so say so plainly rather than dressing it
// as a gateway problem.
func markBuildFail(err error) int {
	launcher.NewUI(false).Fail("could not build the annotation: %v", err)
	return 1
}
