// Code generated from specs/src/bus/registry.json — DO NOT EDIT.
//
// Regenerate: node scripts/bus/generate-go.mjs
// The TypeScript side (packages/core/src/bus-protocol.ts) generates from the
// same registry, so the two languages cannot drift apart by hand.

package bus

// Operation is one request/reply pair: emit the request channel with a
// correlationId, then take the first matching Result or Failure. Progress is
// set for streaming operations, which emit intermediate events under the same
// correlationId before the terminal reply.
type Operation struct {
	Result   Channel
	Failure  Channel
	Progress Channel // "" when the operation is not streaming
}

// Operations is the request→reply registry: 38 operations.
var Operations = map[Channel]Operation{
	"bind:update-body":                           {Result: "bind:body-updated", Failure: "bind:body-update-failed"},
	"browse:resource-requested":                  {Result: "browse:resource-result", Failure: "browse:resource-failed"},
	"browse:anchored-text-requested":             {Result: "browse:anchored-text-result", Failure: "browse:anchored-text-failed"},
	"browse:anchored-text-by-checksum-requested": {Result: "browse:anchored-text-by-checksum-result", Failure: "browse:anchored-text-by-checksum-failed"},
	"browse:resources-requested":                 {Result: "browse:resources-result", Failure: "browse:resources-failed"},
	"browse:annotation-requested":                {Result: "browse:annotation-result", Failure: "browse:annotation-failed"},
	"browse:annotations-requested":               {Result: "browse:annotations-result", Failure: "browse:annotations-failed"},
	"browse:annotation-history-requested":        {Result: "browse:annotation-history-result", Failure: "browse:annotation-history-failed"},
	"browse:events-requested":                    {Result: "browse:events-result", Failure: "browse:events-failed"},
	"browse:referenced-by-requested":             {Result: "browse:referenced-by-result", Failure: "browse:referenced-by-failed"},
	"browse:entity-types-requested":              {Result: "browse:entity-types-result", Failure: "browse:entity-types-failed"},
	"browse:tag-schemas-requested":               {Result: "browse:tag-schemas-result", Failure: "browse:tag-schemas-failed"},
	"browse:agents-requested":                    {Result: "browse:agents-result", Failure: "browse:agents-failed"},
	"browse:directory-requested":                 {Result: "browse:directory-result", Failure: "browse:directory-failed"},
	"browse:annotation-context-requested":        {Result: "browse:annotation-context-result", Failure: "browse:annotation-context-failed"},
	"frame:add-entity-type":                      {Result: "frame:entity-type-add-ok", Failure: "frame:entity-type-add-failed"},
	"frame:add-tag-schema":                       {Result: "frame:tag-schema-add-ok", Failure: "frame:tag-schema-add-failed"},
	"gather:requested":                           {Result: "gather:complete", Failure: "gather:failed", Progress: "gather:annotation-progress"},
	"gather:resource-requested":                  {Result: "gather:resource-complete", Failure: "gather:resource-failed"},
	"gather:summary-requested":                   {Result: "gather:summary-result", Failure: "gather:summary-failed"},
	"job:create":                                 {Result: "job:created", Failure: "job:create-failed"},
	"job:status-requested":                       {Result: "job:status-result", Failure: "job:status-failed"},
	"job:cancel-requested":                       {Result: "job:cancel-ok", Failure: "job:cancel-failed"},
	"job:claim":                                  {Result: "job:claimed", Failure: "job:claim-failed"},
	"mark:create-request":                        {Result: "mark:create-ok", Failure: "mark:create-failed"},
	"mark:delete":                                {Result: "mark:delete-ok", Failure: "mark:delete-failed"},
	"mark:archive":                               {Result: "mark:archive-ok", Failure: "mark:archive-failed"},
	"mark:unarchive":                             {Result: "mark:unarchive-ok", Failure: "mark:unarchive-failed"},
	"mark:update-entity-types":                   {Result: "mark:update-entity-types-ok", Failure: "mark:update-entity-types-failed"},
	"match:search-requested":                     {Result: "match:search-results", Failure: "match:search-failed"},
	"weave:rebuild":                              {Result: "weave:rebuild-ok", Failure: "weave:rebuild-failed"},
	"smelt:rebuild-anchors":                      {Result: "smelt:rebuild-anchors-ok", Failure: "smelt:rebuild-anchors-failed"},
	"yield:create":                               {Result: "yield:create-ok", Failure: "yield:create-failed"},
	"yield:clone-persist":                        {Result: "yield:clone-persist-ok", Failure: "yield:clone-persist-failed"},
	"yield:update":                               {Result: "yield:update-ok", Failure: "yield:update-failed"},
	"yield:clone-create":                         {Result: "yield:clone-created", Failure: "yield:clone-create-failed"},
	"yield:clone-resource-requested":             {Result: "yield:clone-resource-result", Failure: "yield:clone-resource-failed"},
	"yield:clone-token-requested":                {Result: "yield:clone-token-generated", Failure: "yield:clone-token-failed"},
}

// Streaming reports whether this operation emits progress events before its
// terminal reply.
func (o Operation) Streaming() bool { return o.Progress != "" }
