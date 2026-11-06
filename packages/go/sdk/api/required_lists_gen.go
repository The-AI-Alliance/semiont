// Code generated from the component schemas of protocol/specs/src/openapi.json and api/client_gen.go — DO NOT EDIT.
//
// Regenerate: node packages/codegen/schemas/generate-required-lists-go.mjs

package api

import (
	"encoding/json"
	"slices"
)

// listOf is list, or the empty list where Go holds list as nil. Go takes both
// for the empty list; encoding/json writes the one as [] and the other as
// null, which a member its schema requires may not be.
func listOf[S ~[]E, E any](list S) S {
	if list == nil {
		return S{}
	}
	return list
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v AnchoredText) MarshalJSON() ([]byte, error) {
	type written AnchoredText
	v.Items = listOf(v.Items)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v AnchoredTextEntries) MarshalJSON() ([]byte, error) {
	type written AnchoredTextEntries
	v.Checksums = listOf(v.Checksums)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v AnchoredTextExtractedEntry) MarshalJSON() ([]byte, error) {
	type written AnchoredTextExtractedEntry
	v.Lines = listOf(v.Lines)
	lines := slices.Clone(v.Lines)
	for i := range lines {
		lines[i].Words = listOf(lines[i].Words)
	}
	v.Lines = lines
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v AnnotationBodyUpdatedPayload) MarshalJSON() ([]byte, error) {
	type written AnnotationBodyUpdatedPayload
	v.Operations = listOf(v.Operations)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v ArchivistEventsResponse) MarshalJSON() ([]byte, error) {
	type written ArchivistEventsResponse
	v.Events = listOf(v.Events)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v ArchivistHealth) MarshalJSON() ([]byte, error) {
	type written ArchivistHealth
	v.Actors = listOf(v.Actors)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v ArchivistStreamsResponse) MarshalJSON() ([]byte, error) {
	type written ArchivistStreamsResponse
	v.Streams = listOf(v.Streams)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v BindInitiateCommand) MarshalJSON() ([]byte, error) {
	type written BindInitiateCommand
	v.EntityTypes = listOf(v.EntityTypes)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v BindUpdateBodyCommand) MarshalJSON() ([]byte, error) {
	type written BindUpdateBodyCommand
	v.Operations = listOf(v.Operations)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v BrowseDirectoryResultResponse) MarshalJSON() ([]byte, error) {
	type written BrowseDirectoryResultResponse
	v.Entries = listOf(v.Entries)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v BrowseEnginesResult) MarshalJSON() ([]byte, error) {
	type written BrowseEnginesResult
	v.Response.Engines = listOf(v.Response.Engines)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v BrowseFilesResponse) MarshalJSON() ([]byte, error) {
	type written BrowseFilesResponse
	v.Entries = listOf(v.Entries)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v BrowseProfilesRequest) MarshalJSON() ([]byte, error) {
	type written BrowseProfilesRequest
	v.Dids = listOf(v.Dids)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v BusSubscribeRequest) MarshalJSON() ([]byte, error) {
	type written BusSubscribeRequest
	if v.Scoped != nil {
		scoped := slices.Clone(*v.Scoped)
		for i := range scoped {
			scoped[i].Channels = listOf(scoped[i].Channels)
		}
		v.Scoped = &scoped
	}
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v ContextualSummaryResponse) MarshalJSON() ([]byte, error) {
	type written ContextualSummaryResponse
	v.RelevantFields.EntityTypes = listOf(v.RelevantFields.EntityTypes)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v DiscoveryDocument) MarshalJSON() ([]byte, error) {
	type written DiscoveryDocument
	v.Kbs = listOf(v.Kbs)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v EntityTypesProjection) MarshalJSON() ([]byte, error) {
	type written EntityTypesProjection
	v.EntityTypes = listOf(v.EntityTypes)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v ExtractedText) MarshalJSON() ([]byte, error) {
	type written ExtractedText
	v.Items = listOf(v.Items)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v GatheredContext) MarshalJSON() ([]byte, error) {
	type written GatheredContext
	if v.SemanticContext != nil {
		semanticContext := *v.SemanticContext
		semanticContext.Similar = listOf(semanticContext.Similar)
		v.SemanticContext = &semanticContext
	}
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v GetAnnotationHistoryResponse) MarshalJSON() ([]byte, error) {
	type written GetAnnotationHistoryResponse
	v.Events = listOf(v.Events)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v GetAnnotationsResponse) MarshalJSON() ([]byte, error) {
	type written GetAnnotationsResponse
	v.Annotations = listOf(v.Annotations)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v GetEntityTypesResponse) MarshalJSON() ([]byte, error) {
	type written GetEntityTypesResponse
	v.EntityTypes = listOf(v.EntityTypes)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v GetEventsResponse) MarshalJSON() ([]byte, error) {
	type written GetEventsResponse
	v.Events = listOf(v.Events)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v GetReferencedByResponse) MarshalJSON() ([]byte, error) {
	type written GetReferencedByResponse
	v.ReferencedBy = listOf(v.ReferencedBy)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v GetResourceResponse) MarshalJSON() ([]byte, error) {
	type written GetResourceResponse
	v.Annotations = listOf(v.Annotations)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v GetTagSchemasResponse) MarshalJSON() ([]byte, error) {
	type written GetTagSchemasResponse
	v.TagSchemas = listOf(v.TagSchemas)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v InferenceLimitsResult) MarshalJSON() ([]byte, error) {
	type written InferenceLimitsResult
	v.Response.Limits = listOf(v.Response.Limits)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v JobCheckpointCommand) MarshalJSON() ([]byte, error) {
	type written JobCheckpointCommand
	v.CompletedUnits = listOf(v.CompletedUnits)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v JobClaimCommand) MarshalJSON() ([]byte, error) {
	type written JobClaimCommand
	v.Accepts = listOf(v.Accepts)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v KnowledgeGraph) MarshalJSON() ([]byte, error) {
	type written KnowledgeGraph
	v.Edges = listOf(v.Edges)
	v.Nodes = listOf(v.Nodes)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v LinkingJobParams) MarshalJSON() ([]byte, error) {
	type written LinkingJobParams
	v.EntityTypes = listOf(v.EntityTypes)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v ListResourcesResponse) MarshalJSON() ([]byte, error) {
	type written ListResourcesResponse
	v.Resources = listOf(v.Resources)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v MarkCommitCommand) MarshalJSON() ([]byte, error) {
	type written MarkCommitCommand
	v.Annotations = listOf(v.Annotations)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v MarkCommitOk) MarshalJSON() ([]byte, error) {
	type written MarkCommitOk
	v.Response.AnnotationIds = listOf(v.Response.AnnotationIds)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v MarkUpdateBodyCommand) MarshalJSON() ([]byte, error) {
	type written MarkUpdateBodyCommand
	v.Operations = listOf(v.Operations)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v MarkUpdateEntityTypesCommand) MarshalJSON() ([]byte, error) {
	type written MarkUpdateEntityTypesCommand
	v.CurrentEntityTypes = listOf(v.CurrentEntityTypes)
	v.UpdatedEntityTypes = listOf(v.UpdatedEntityTypes)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v MatchResourcesResponse) MarshalJSON() ([]byte, error) {
	type written MatchResourcesResponse
	v.Resources = listOf(v.Resources)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v MatchSearchResult) MarshalJSON() ([]byte, error) {
	type written MatchSearchResult
	v.Response = listOf(v.Response)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v ProtectedResourceMetadata) MarshalJSON() ([]byte, error) {
	type written ProtectedResourceMetadata
	v.AuthorizationServers = listOf(v.AuthorizationServers)
	v.BearerMethodsSupported = listOf(v.BearerMethodsSupported)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v ResourceAnnotations) MarshalJSON() ([]byte, error) {
	type written ResourceAnnotations
	v.Annotations = listOf(v.Annotations)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v TagCategory) MarshalJSON() ([]byte, error) {
	type written TagCategory
	v.Examples = listOf(v.Examples)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v TagSchema) MarshalJSON() ([]byte, error) {
	type written TagSchema
	v.Tags = listOf(v.Tags)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v TagSchemasProjection) MarshalJSON() ([]byte, error) {
	type written TagSchemasProjection
	v.TagSchemas = listOf(v.TagSchemas)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v TaggingJobParams) MarshalJSON() ([]byte, error) {
	type written TaggingJobParams
	v.Categories = listOf(v.Categories)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v UpdateAnnotationBodyRequest) MarshalJSON() ([]byte, error) {
	type written UpdateAnnotationBodyRequest
	v.Operations = listOf(v.Operations)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v WorkerConfig) MarshalJSON() ([]byte, error) {
	type written WorkerConfig
	v.KnowledgeBases = listOf(v.KnowledgeBases)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v WorkerEngineConfig) MarshalJSON() ([]byte, error) {
	type written WorkerEngineConfig
	v.Jobs = listOf(v.Jobs)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v WorkerEngineHealth) MarshalJSON() ([]byte, error) {
	type written WorkerEngineHealth
	v.Jobs = listOf(v.Jobs)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v WorkerHealth) MarshalJSON() ([]byte, error) {
	type written WorkerHealth
	v.KnowledgeBases = listOf(v.KnowledgeBases)
	return json.Marshal(written(v))
}

// MarshalJSON writes v, each list its schema requires that Go holds as nil
// written as the empty list.
func (v WorkerKnowledgeBaseConfig) MarshalJSON() ([]byte, error) {
	type written WorkerKnowledgeBaseConfig
	v.Engines = listOf(v.Engines)
	return json.Marshal(written(v))
}
