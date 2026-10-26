// Code generated from specs/src/bus/registry.json — DO NOT EDIT.
//
// Regenerate: node scripts/bus/generate-go.mjs

package bus

import "github.com/The-AI-Alliance/semiont/packages/sdk-go/api"

// Every operation, named for its request channel and typed by what it sends
// and what each of its replies carries.
var (
	BindUpdateBody                   = Operation[api.BindUpdateBodyCommand, api.BindBodyUpdated, api.CommandError]{"bind:update-body", "bind:body-updated", "bind:body-update-failed"}
	BrowseResourceRequested          = Operation[api.BrowseResourceRequest, api.BrowseResourceResult, api.CommandError]{"browse:resource-requested", "browse:resource-result", "browse:resource-failed"}
	BrowseResourcesRequested         = Operation[api.BrowseResourcesRequest, api.BrowseResourcesResult, api.CommandError]{"browse:resources-requested", "browse:resources-result", "browse:resources-failed"}
	BrowseAnnotationRequested        = Operation[api.BrowseAnnotationRequest, api.BrowseAnnotationResult, api.CommandError]{"browse:annotation-requested", "browse:annotation-result", "browse:annotation-failed"}
	BrowseAnnotationHistoryRequested = Operation[api.BrowseAnnotationHistoryRequest, api.BrowseAnnotationHistoryResult, api.CommandError]{"browse:annotation-history-requested", "browse:annotation-history-result", "browse:annotation-history-failed"}
	BrowseEventsRequested            = Operation[api.BrowseEventsRequest, api.BrowseEventsResult, api.CommandError]{"browse:events-requested", "browse:events-result", "browse:events-failed"}
	BrowseEntityTypesRequested       = Operation[api.BrowseEntityTypesRequest, api.BrowseEntityTypesResult, api.CommandError]{"browse:entity-types-requested", "browse:entity-types-result", "browse:entity-types-failed"}
	BrowseTagSchemasRequested        = Operation[api.BrowseTagSchemasRequest, api.BrowseTagSchemasResult, api.CommandError]{"browse:tag-schemas-requested", "browse:tag-schemas-result", "browse:tag-schemas-failed"}
	BrowseAgentsRequested            = Operation[api.BrowseAgentsRequest, api.BrowseAgentsResult, api.CommandError]{"browse:agents-requested", "browse:agents-result", "browse:agents-failed"}
	BrowsePeopleRequested            = Operation[api.BrowsePeopleRequest, api.BrowsePeopleResult, api.CommandError]{"browse:people-requested", "browse:people-result", "browse:people-failed"}
	BrowseKbRequested                = Operation[api.BrowseKbRequest, api.BrowseKbResult, api.CommandError]{"browse:kb-requested", "browse:kb-result", "browse:kb-failed"}
	BrowseDirectoryRequested         = Operation[api.BrowseDirectoryRequest, api.BrowseDirectoryResult, api.BrowseDirectoryFailed]{"browse:directory-requested", "browse:directory-result", "browse:directory-failed"}
	FrameAddEntityType               = Operation[api.FrameAddEntityTypeCommand, Empty, api.CommandError]{"frame:add-entity-type", "frame:entity-type-add-ok", "frame:entity-type-add-failed"}
	FrameAddTagSchema                = Operation[api.FrameAddTagSchemaCommand, Empty, api.CommandError]{"frame:add-tag-schema", "frame:tag-schema-add-ok", "frame:tag-schema-add-failed"}
	GatherRequested                  = Operation[api.GatherAnnotationRequest, api.GatherAnnotationComplete, api.GatherFailed]{"gather:requested", "gather:complete", "gather:failed"}
	GatherResourceRequested          = Operation[api.GatherResourceRequest, api.GatherResourceComplete, api.GatherResourceFailed]{"gather:resource-requested", "gather:resource-complete", "gather:resource-failed"}
	GatherSummaryRequested           = Operation[api.GatherSummaryRequest, Response[api.ContextualSummaryResponse], api.CommandError]{"gather:summary-requested", "gather:summary-result", "gather:summary-failed"}
	GatherReferencedByRequested      = Operation[api.GatherReferencedByRequest, api.GatherReferencedByResult, api.CommandError]{"gather:referenced-by-requested", "gather:referenced-by-result", "gather:referenced-by-failed"}
	GatherLimitsRequested            = Operation[api.InferenceLimitsRequest, api.InferenceLimitsResult, api.CommandError]{"gather:limits-requested", "gather:limits-result", "gather:limits-failed"}
	JobCreate                        = Operation[api.JobCreateCommand, api.JobCreatedResult, api.CommandError]{"job:create", "job:created", "job:create-failed"}
	JobStatusRequested               = Operation[api.JobStatusRequest, api.JobStatusResult, api.CommandError]{"job:status-requested", "job:status-result", "job:status-failed"}
	JobLimitsRequested               = Operation[api.InferenceLimitsRequest, api.InferenceLimitsResult, api.CommandError]{"job:limits-requested", "job:limits-result", "job:limits-failed"}
	JobCancelRequested               = Operation[api.JobCancelRequest, Response[api.JobCancelResult], api.CommandError]{"job:cancel-requested", "job:cancel-ok", "job:cancel-failed"}
	JobClaim                         = Operation[api.JobClaimCommand, api.JobClaimedResult, api.CommandError]{"job:claim", "job:claimed", "job:claim-failed"}
	MarkCreateRequest                = Operation[api.MarkCreateRequest, api.MarkCreateOk, api.CommandError]{"mark:create-request", "mark:create-ok", "mark:create-failed"}
	MarkCommit                       = Operation[api.MarkCommitCommand, api.MarkCommitOk, api.CommandError]{"mark:commit", "mark:commit-ok", "mark:commit-failed"}
	MarkDelete                       = Operation[api.MarkDeleteCommand, api.MarkDeleteOk, api.CommandError]{"mark:delete", "mark:delete-ok", "mark:delete-failed"}
	MarkArchive                      = Operation[api.MarkArchiveCommand, Empty, api.CommandError]{"mark:archive", "mark:archive-ok", "mark:archive-failed"}
	MarkUnarchive                    = Operation[api.MarkUnarchiveCommand, Empty, api.CommandError]{"mark:unarchive", "mark:unarchive-ok", "mark:unarchive-failed"}
	MarkUpdateEntityTypes            = Operation[api.MarkUpdateEntityTypesCommand, Empty, api.CommandError]{"mark:update-entity-types", "mark:update-entity-types-ok", "mark:update-entity-types-failed"}
	MatchSearchRequested             = Operation[api.MatchSearchRequest, api.MatchSearchResult, api.MatchSearchFailed]{"match:search-requested", "match:search-results", "match:search-failed"}
	MatchResourcesRequested          = Operation[api.MatchResourcesRequest, api.MatchResourcesResult, api.CommandError]{"match:resources-requested", "match:resources-result", "match:resources-failed"}
	MatchLimitsRequested             = Operation[api.InferenceLimitsRequest, api.InferenceLimitsResult, api.CommandError]{"match:limits-requested", "match:limits-result", "match:limits-failed"}
	WeaveRebuild                     = Operation[api.WeaveRebuildCommand, Empty, api.CommandError]{"weave:rebuild", "weave:rebuild-ok", "weave:rebuild-failed"}
	SmeltRebuildAnchors              = Operation[api.SmeltRebuildAnchorsCommand, Empty, api.CommandError]{"smelt:rebuild-anchors", "smelt:rebuild-anchors-ok", "smelt:rebuild-anchors-failed"}
	YieldCreate                      = Operation[api.YieldCreateCommand, api.YieldCreateOk, api.CommandError]{"yield:create", "yield:create-ok", "yield:create-failed"}
	YieldClonePersist                = Operation[api.YieldClonePersistCommand, api.YieldClonePersistOk, api.CommandError]{"yield:clone-persist", "yield:clone-persist-ok", "yield:clone-persist-failed"}
	YieldUpdate                      = Operation[api.YieldUpdateCommand, api.YieldUpdateOk, api.CommandError]{"yield:update", "yield:update-ok", "yield:update-failed"}
	YieldCloneCreate                 = Operation[api.YieldCloneCreateCommand, api.YieldCloneCreated, api.CommandError]{"yield:clone-create", "yield:clone-created", "yield:clone-create-failed"}
	YieldCloneResourceRequested      = Operation[api.YieldCloneResourceRequest, Response[api.GetResourceByTokenResponse], api.CommandError]{"yield:clone-resource-requested", "yield:clone-resource-result", "yield:clone-resource-failed"}
	YieldCloneTokenRequested         = Operation[api.YieldCloneTokenRequest, Response[api.CloneResourceWithTokenResponse], api.CommandError]{"yield:clone-token-requested", "yield:clone-token-generated", "yield:clone-token-failed"}
)

// LimitsOperations is the operations that report the limits of the models a
// service holds credentials for: one per such service, each named
// <flow>:limits-requested. A new key holder's joins by being registered.
var LimitsOperations = []Operation[api.InferenceLimitsRequest, api.InferenceLimitsResult, api.CommandError]{
	GatherLimitsRequested,
	JobLimitsRequested,
	MatchLimitsRequested,
}

// Replies is the two channels a request is answered on.
type Replies struct {
	Result  Channel
	Failure Channel
}

// Operations is each operation's replies, by the name of its request
// channel: for a request named at run time. 41 operations.
var Operations = map[Channel]Replies{
	"bind:update-body":                    {Result: "bind:body-updated", Failure: "bind:body-update-failed"},
	"browse:resource-requested":           {Result: "browse:resource-result", Failure: "browse:resource-failed"},
	"browse:resources-requested":          {Result: "browse:resources-result", Failure: "browse:resources-failed"},
	"browse:annotation-requested":         {Result: "browse:annotation-result", Failure: "browse:annotation-failed"},
	"browse:annotation-history-requested": {Result: "browse:annotation-history-result", Failure: "browse:annotation-history-failed"},
	"browse:events-requested":             {Result: "browse:events-result", Failure: "browse:events-failed"},
	"browse:entity-types-requested":       {Result: "browse:entity-types-result", Failure: "browse:entity-types-failed"},
	"browse:tag-schemas-requested":        {Result: "browse:tag-schemas-result", Failure: "browse:tag-schemas-failed"},
	"browse:agents-requested":             {Result: "browse:agents-result", Failure: "browse:agents-failed"},
	"browse:people-requested":             {Result: "browse:people-result", Failure: "browse:people-failed"},
	"browse:kb-requested":                 {Result: "browse:kb-result", Failure: "browse:kb-failed"},
	"browse:directory-requested":          {Result: "browse:directory-result", Failure: "browse:directory-failed"},
	"frame:add-entity-type":               {Result: "frame:entity-type-add-ok", Failure: "frame:entity-type-add-failed"},
	"frame:add-tag-schema":                {Result: "frame:tag-schema-add-ok", Failure: "frame:tag-schema-add-failed"},
	"gather:requested":                    {Result: "gather:complete", Failure: "gather:failed"},
	"gather:resource-requested":           {Result: "gather:resource-complete", Failure: "gather:resource-failed"},
	"gather:summary-requested":            {Result: "gather:summary-result", Failure: "gather:summary-failed"},
	"gather:referenced-by-requested":      {Result: "gather:referenced-by-result", Failure: "gather:referenced-by-failed"},
	"gather:limits-requested":             {Result: "gather:limits-result", Failure: "gather:limits-failed"},
	"job:create":                          {Result: "job:created", Failure: "job:create-failed"},
	"job:status-requested":                {Result: "job:status-result", Failure: "job:status-failed"},
	"job:limits-requested":                {Result: "job:limits-result", Failure: "job:limits-failed"},
	"job:cancel-requested":                {Result: "job:cancel-ok", Failure: "job:cancel-failed"},
	"job:claim":                           {Result: "job:claimed", Failure: "job:claim-failed"},
	"mark:create-request":                 {Result: "mark:create-ok", Failure: "mark:create-failed"},
	"mark:commit":                         {Result: "mark:commit-ok", Failure: "mark:commit-failed"},
	"mark:delete":                         {Result: "mark:delete-ok", Failure: "mark:delete-failed"},
	"mark:archive":                        {Result: "mark:archive-ok", Failure: "mark:archive-failed"},
	"mark:unarchive":                      {Result: "mark:unarchive-ok", Failure: "mark:unarchive-failed"},
	"mark:update-entity-types":            {Result: "mark:update-entity-types-ok", Failure: "mark:update-entity-types-failed"},
	"match:search-requested":              {Result: "match:search-results", Failure: "match:search-failed"},
	"match:resources-requested":           {Result: "match:resources-result", Failure: "match:resources-failed"},
	"match:limits-requested":              {Result: "match:limits-result", Failure: "match:limits-failed"},
	"weave:rebuild":                       {Result: "weave:rebuild-ok", Failure: "weave:rebuild-failed"},
	"smelt:rebuild-anchors":               {Result: "smelt:rebuild-anchors-ok", Failure: "smelt:rebuild-anchors-failed"},
	"yield:create":                        {Result: "yield:create-ok", Failure: "yield:create-failed"},
	"yield:clone-persist":                 {Result: "yield:clone-persist-ok", Failure: "yield:clone-persist-failed"},
	"yield:update":                        {Result: "yield:update-ok", Failure: "yield:update-failed"},
	"yield:clone-create":                  {Result: "yield:clone-created", Failure: "yield:clone-create-failed"},
	"yield:clone-resource-requested":      {Result: "yield:clone-resource-result", Failure: "yield:clone-resource-failed"},
	"yield:clone-token-requested":         {Result: "yield:clone-token-generated", Failure: "yield:clone-token-failed"},
}
