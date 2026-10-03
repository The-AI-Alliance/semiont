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
	"errors"
	"fmt"
	"math"
	"os"
	"sort"
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

Options:
  --instructions <text>    What the pass should attend to
  --density <n>            Aim for about n annotations per 2000 words
  --tone <t>               The voice of what is written: scholarly | explanatory |
                           conversational | technical | analytical | critical |
                           balanced | constructive
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

// assistOptions: what a delegated mark says of the pass it asks for. Each is
// a parameter of the job, under its own name.
type assistOptions struct {
	EntityTypes                  []string `json:"entityTypes,omitempty"`
	IncludeDescriptiveReferences *bool    `json:"includeDescriptiveReferences,omitempty"`
	Instructions                 string   `json:"instructions,omitempty"`
	Density                      *float64 `json:"density,omitempty"`
	Tone                         string   `json:"tone,omitempty"`
	Language                     string   `json:"language,omitempty"`
	SourceLanguage               string   `json:"sourceLanguage,omitempty"`
	SchemaId                     string   `json:"schemaId,omitempty"`
	Categories                   []string `json:"categories,omitempty"`
}

// assistJobTypes: the job a motivation names. The `mark.assist` row of
// specs/src/client/surface.json states it, and
// TestMarkDelegateSendsWhatTheClientSurfaceSays runs every case of that row.
var assistJobTypes = map[semiont.Motivation]semiont.JobType{
	semiont.MotivationHighlighting: semiont.JobTypeHighlightAnnotation,
	semiont.MotivationCommenting:   semiont.JobTypeCommentAnnotation,
	semiont.MotivationAssessing:    semiont.JobTypeAssessmentAnnotation,
	semiont.MotivationLinking:      semiont.JobTypeReferenceAnnotation,
	semiont.MotivationTagging:      semiont.JobTypeTagAnnotation,
}

// assistMotivations: the motivations a delegated mark takes, for a refusal.
func assistMotivations() string {
	names := make([]string, 0, len(assistJobTypes))
	for m := range assistJobTypes {
		names = append(names, string(m))
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// assistJob: the job:create a delegated mark sends. It refuses what every SDK
// refuses before asking: a job the dispatcher would turn away, or one with
// nothing to look for.
func assistJob(resourceID string, motivation semiont.Motivation, options assistOptions) (semiont.JobCreateCommand, error) {
	jobType, ok := assistJobTypes[motivation]
	if !ok {
		return semiont.JobCreateCommand{}, fmt.Errorf("--motivation wants one of %s; got %q", assistMotivations(), motivation)
	}
	switch motivation {
	case semiont.MotivationLinking:
		if len(options.EntityTypes) == 0 {
			return semiont.JobCreateCommand{}, errors.New("linking needs at least one --entity-type to look for (semiont browse --entity-types lists them)")
		}
	case semiont.MotivationTagging:
		if options.SchemaId == "" {
			return semiont.JobCreateCommand{}, errors.New("tagging needs --schema <id> (semiont browse --tag-schemas lists them)")
		}
		if len(options.Categories) == 0 {
			return semiont.JobCreateCommand{}, errors.New("tagging needs at least one --category of that schema")
		}
	}
	// The options ARE the job's parameters. The resource is the command's:
	// the dispatcher refuses params that name it.
	b, err := json.Marshal(options)
	if err != nil {
		return semiont.JobCreateCommand{}, err
	}
	params := map[string]any{}
	if err := json.Unmarshal(b, &params); err != nil {
		return semiont.JobCreateCommand{}, err
	}
	return semiont.JobCreateCommand{JobType: jobType, ResourceId: &resourceID, Params: params}, nil
}

func Mark(args []string) int {
	u := launcher.NewUI(false)
	var resourceID, quote, prefix, suffix, bodyText, link, motivation, deleteID, resourceFlag, repo string
	var entityTypes []string
	start, end := -1, -1
	asJSON, wantLocal := false, false
	delegate := false
	var assist assistOptions
	// given: the flags that belong to one form of mark only, as they were
	// typed, so the other form can refuse them by name.
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
		var ok bool
		switch a {
		case "--quote", "--prefix", "--suffix", "--body-text", "--link", "--delete", "--resource", "--start", "--end":
			handOnly = append(handOnly, a)
		case "--instructions", "--density", "--tone", "--language", "--source-language", "--descriptive", "--schema", "--category":
			delegateOnly = append(delegateOnly, a)
		}
		switch a {
		case "--delegate":
			delegate, ok = true, true
		case "--instructions":
			assist.Instructions, ok = val()
		case "--density":
			var v string
			if v, ok = val(); ok {
				n, err := strconv.ParseFloat(v, 64)
				if err != nil || n <= 0 || math.IsInf(n, 0) || math.IsNaN(n) {
					u.Fail("--density wants a number above 0 (about that many annotations per 2000 words), got %q", v)
					return 1
				}
				assist.Density = &n
			}
		case "--tone":
			if assist.Tone, ok = val(); ok && !semiont.MarkAssistRequestEventOptionsTone(assist.Tone).Valid() {
				u.Fail("--tone wants a tone the help lists, got %q:  semiont mark --delegate --help", assist.Tone)
				return 1
			}
		case "--language":
			assist.Language, ok = val()
		case "--source-language":
			assist.SourceLanguage, ok = val()
		case "--descriptive":
			yes := true
			assist.IncludeDescriptiveReferences, ok = &yes, true
		case "--schema":
			assist.SchemaId, ok = val()
		case "--category":
			var v string
			if v, ok = val(); ok {
				assist.Categories = append(assist.Categories, v)
			}
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
			u.Fail("--delegate needs --motivation: one of %s.", assistMotivations())
			return 1
		}
		assist.EntityTypes = entityTypes
		command, err := assistJob(resourceID, semiont.Motivation(motivation), assist)
		if err != nil {
			u.Fail("%v", err)
			return 1
		}
		t, ok := launcher.VerbSession(u, "mark", repo, wantLocal)
		if !ok {
			return 1
		}
		return runMarkDelegate(u, t, command, resourceID, motivation, asJSON)
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
			Start: float32(start), End: float32(end),
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

// runMarkDelegate creates the annotation job and follows it to its end.
func runMarkDelegate(u *launcher.UI, t launcher.VerbTarget, command semiont.JobCreateCommand, resourceID, motivation string, asJSON bool) int {
	done, raw, ok := delegatedJob{
		verb: "mark --delegate", doing: "Annotating " + resourceID, note: motivation, failed: "Annotation",
		check:  "semiont browse " + resourceID + " --annotations",
		create: command,
	}.run(u, t.Transport())
	if !ok {
		return 1
	}
	result := jobResult(done)
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
	if text := markedText(result); text != "" {
		u.Ok("Marked %s: %s", resourceID, text)
		return 0
	}
	u.Ok("Marked %s %s", resourceID, u.Dim("("+motivation+")"))
	return 0
}

// markedText: what a completed annotation job did, in the terminal's words.
// "" for a result that is not an annotation job's.
func markedText(result any) string {
	created := func(n int, what string, found int) string {
		return fmt.Sprintf("%s created (%d found)", counted(n, what), found)
	}
	switch r := result.(type) {
	case semiont.JobHighlightAnnotationResult:
		return created(r.HighlightsCreated, "highlight", r.HighlightsFound)
	case semiont.JobCommentAnnotationResult:
		return created(r.CommentsCreated, "comment", r.CommentsFound)
	case semiont.JobAssessmentAnnotationResult:
		return created(r.AssessmentsCreated, "assessment", r.AssessmentsFound)
	case semiont.JobReferenceAnnotationResult:
		text := fmt.Sprintf("%s created (%d found", counted(r.TotalEmitted, "reference"), r.TotalFound)
		if r.Errors > 0 {
			text += ", " + counted(r.Errors, "error")
		}
		return text + ")"
	case semiont.JobTagAnnotationResult:
		text := created(r.TagsCreated, "tag", r.TagsFound)
		categories := make([]string, 0, len(r.ByCategory))
		for name := range r.ByCategory {
			categories = append(categories, name)
		}
		sort.Strings(categories)
		for i, name := range categories {
			categories[i] = fmt.Sprintf("%s %d", name, r.ByCategory[name])
		}
		if len(categories) > 0 {
			text += ": " + strings.Join(categories, ", ")
		}
		return text
	}
	return ""
}

// counted: "1 highlight", "3 highlights".
func counted(n int, what string) string {
	if n == 1 {
		return "1 " + what
	}
	return fmt.Sprintf("%d %ss", n, what)
}

// markBuildFail: a union constructor only fails on a programming error here
// (the value cannot be encoded), so say so plainly rather than dressing it
// as a gateway problem.
func markBuildFail(err error) int {
	launcher.NewUI(false).Fail("could not build the annotation: %v", err)
	return 1
}
