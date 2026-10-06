# Generated from specs/openapi.json, the bundled spec; do not edit.
# Regenerate: uv run python scripts/generate_models.py (in packages/sdk-python)

from __future__ import annotations

from typing import Annotated, Literal
from pydantic import JsonValue, Field
from semiont.model import WireModel
from semiont.identifiers import AnnotationId, JobId, ResourceId, UserId

__all__ = [
    "Actors",
    "Agent",
    "AgentOrganization",
    "AgentPerson",
    "AgentSoftware",
    "AgentTokenRequest",
    "AgentTokenResponse",
    "AnchoredText",
    "AnchoredTextAbsent",
    "AnchoredTextAnswer",
    "AnchoredTextDeclinedEntry",
    "AnchoredTextEntry",
    "AnchoredTextExtractedEntry",
    "Annotation",
    "AnnotationAddedPayload",
    "AnnotationBodies",
    "AnnotationBody",
    "AnnotationBodyUpdatedPayload",
    "AnnotationContextResponse",
    "AnnotationRemovedPayload",
    "AnnotationSelector",
    "AnnotationTarget",
    "Archivist",
    "ArchivistConfig",
    "ArchivistEventsResponse",
    "ArchivistHealth",
    "ArchivistRoster",
    "ArchivistRosterRole",
    "AttributedEvent",
    "BeckonFocusEvent",
    "BeckonHoverEvent",
    "BeckonSparkleEvent",
    "BindBodyOperation",
    "BindBodyUpdated",
    "BindInitiateCommand",
    "BindUpdateBodyCommand",
    "BodyOperationAdd",
    "BodyOperationRemove",
    "BodyOperationReplace",
    "BodyPurpose",
    "BrowseAgentsRequest",
    "BrowseAgentsResult",
    "BrowseAnchoredTextRequest",
    "BrowseAnchoredTextResult",
    "BrowseAnnotationContextRequest",
    "BrowseAnnotationHistoryRequest",
    "BrowseAnnotationHistoryResult",
    "BrowseAnnotationRequest",
    "BrowseAnnotationResult",
    "BrowseAnnotationsRequest",
    "BrowseAnnotationsResult",
    "BrowseClickEvent",
    "BrowseDirectoryFailed",
    "BrowseDirectoryRequest",
    "BrowseDirectoryResult",
    "BrowseEntityTypeClickedEvent",
    "BrowseEntityTypesRequest",
    "BrowseEntityTypesResult",
    "BrowseEventsRequest",
    "BrowseEventsResult",
    "BrowseExternalNavigateEvent",
    "BrowseFilesResponse",
    "BrowseKbRequest",
    "BrowseKbResult",
    "BrowseLinkClickedEvent",
    "BrowsePanelOpenEvent",
    "BrowsePanelToggleEvent",
    "BrowseResourceCloseEvent",
    "BrowseResourceOpenEvent",
    "BrowseResourceReorderEvent",
    "BrowseResourceRequest",
    "BrowseResourceResult",
    "BrowseResourceViewedEvent",
    "BrowseResourcesRequest",
    "BrowseResourcesResult",
    "BrowseRouterPushEvent",
    "BrowseTagSchemasRequest",
    "BrowseTagSchemasResult",
    "BusEmitAccepted",
    "BusEmitRequest",
    "BusEventMessage",
    "BusFrame",
    "BusPingMessage",
    "BusResumeGap",
    "BusStreamMessage",
    "BusSubscribeRequest",
    "Capacity",
    "CloneResourceWithTokenResponse",
    "CollaboratorEntry",
    "CommandError",
    "CompletedItem",
    "Content",
    "ContentFormat",
    "Context",
    "ContextualSummaryResponse",
    "CreateAnnotationRequest",
    "CreateResourceResponse",
    "Current",
    "DirEntry",
    "DirectoryEntry",
    "DiscoveredKB",
    "DiscoveryDocument",
    "DispatcherConfig",
    "DispatcherHealth",
    "DurabilityEvidence",
    "Edge",
    "EnrichedResourceEvent",
    "EntityTagChangedPayload",
    "EntityTypeAddedPayload",
    "EntityTypesProjection",
    "EphemeralEventId",
    "ErrorResponse",
    "EventMetadata",
    "ExtractedText",
    "ExtractionDeclined",
    "ExtractionOutcome",
    "FailureClass",
    "Features",
    "FileEntry",
    "Focus",
    "Focus1",
    "FragmentSelector",
    "FrameAddEntityTypeCommand",
    "FrameAddTagSchemaCommand",
    "GatewayConfig",
    "GatherAnnotationComplete",
    "GatherAnnotationOptions",
    "GatherAnnotationRequest",
    "GatherFailed",
    "GatherReferencedByRequest",
    "GatherReferencedByResult",
    "GatherResourceComplete",
    "GatherResourceFailed",
    "GatherResourceRequest",
    "GatherSummaryRequest",
    "GatheredContext",
    "GeneratedFrom",
    "GeneratedFrom1",
    "GenerationJobParams",
    "GetAnnotationHistoryResponse",
    "GetAnnotationResponse",
    "GetAnnotationsResponse",
    "GetEntityTypesResponse",
    "GetEventsResponse",
    "GetReferencedByResponse",
    "GetResourceByTokenResponse",
    "GetResourceResponse",
    "GetTagSchemasResponse",
    "GraphAnnotationNode",
    "GraphResourceNode",
    "HealthResponse",
    "Identifier1",
    "Identity",
    "Identity1",
    "Identity2",
    "InferenceLimits",
    "InferenceLimitsRequest",
    "InferenceLimitsResult",
    "InferencePairLimits",
    "Job",
    "JobAssessmentAnnotationResult",
    "JobAssignCommand",
    "JobAssignedPayload",
    "JobCancelCommand",
    "JobCancelRequest",
    "JobCancelResult",
    "JobCancelled",
    "JobCheckpointCommand",
    "JobClaimCommand",
    "JobClaimedResult",
    "JobCommentAnnotationResult",
    "JobComplete",
    "JobCompleteCommand",
    "JobCompletedPayload",
    "JobCreateCommand",
    "JobCreatedResult",
    "JobDeclinedResult",
    "JobFailCommand",
    "JobFailed",
    "JobFailedPayload",
    "JobGenerationResult",
    "JobHighlightAnnotationResult",
    "JobMetadata",
    "JobParams",
    "JobPending",
    "JobProgress",
    "JobProgressAnalyzing",
    "JobProgressAnalyzingTags",
    "JobProgressCompleteCreated",
    "JobProgressCompleteGenerated",
    "JobProgressCreatingAnnotations",
    "JobProgressCreatingResource",
    "JobProgressCreatingTagAnnotations",
    "JobProgressDetectingEntities",
    "JobProgressGeneratingResource",
    "JobProgressLoading",
    "JobProgressMessage",
    "JobQueuedEvent",
    "JobRecord",
    "JobReferenceAnnotationResult",
    "JobReportProgressCommand",
    "JobResult",
    "JobRunning",
    "JobStartCommand",
    "JobStartedPayload",
    "JobStatusRequest",
    "JobStatusResponse",
    "JobStatusResult",
    "JobStoredProgress",
    "JobStoredResult",
    "JobTagAnnotationResult",
    "JobType",
    "Kb",
    "KbDescription",
    "KnowledgeGraph",
    "LimitRefusal",
    "Line",
    "ListResourcesResponse",
    "LogFormat",
    "LogLevel",
    "MarkArchiveCommand",
    "MarkAssistRequestEvent",
    "MarkAssistTimeoutEvent",
    "MarkCommitCommand",
    "MarkCommitOk",
    "MarkCreateCommand",
    "MarkCreateOk",
    "MarkCreateRequest",
    "MarkDeleteCommand",
    "MarkDeleteOk",
    "MarkRequestedEvent",
    "MarkSubmitEvent",
    "MarkUnarchiveCommand",
    "MarkUpdateBodyCommand",
    "MarkUpdateEntityTypesCommand",
    "MatchResourcesRequest",
    "MatchResourcesResponse",
    "MatchResourcesResult",
    "MatchSearchFailed",
    "MatchSearchRequest",
    "MatchSearchResult",
    "MediaTokenRequest",
    "MediaTokenResponse",
    "Metadata",
    "Motivation",
    "OcrConfidence",
    "Options",
    "Options1",
    "PdfTextItem",
    "People",
    "PeopleProjection",
    "PersistedEventId",
    "PersonProfileCommand",
    "PersonProfiledPayload",
    "ProtectedResourceMetadata",
    "Queue",
    "ReferencedByItem",
    "ReplyEventId",
    "Representation",
    "RepresentationAddedPayload",
    "RepresentationNotFound",
    "RepresentationRemovedPayload",
    "RequestParam",
    "ResourceAnnotations",
    "ResourceArchivedPayload",
    "ResourceClonedPayload",
    "ResourceCreatedPayload",
    "ResourceDescriptor",
    "ResourceErrorEvent",
    "ResourceMovedPayload",
    "ResourceUnarchivedPayload",
    "ResourceUpdatedPayload",
    "ResourceUpload",
    "ResourceView",
    "Response",
    "Response1",
    "Response10",
    "Response2",
    "Response3",
    "Response4",
    "Response5",
    "Response6",
    "Response7",
    "Response8",
    "Response9",
    "ScopedItem",
    "ScoredResource",
    "Selected",
    "SelectionData",
    "Selector",
    "Selector1",
    "SemanticContext",
    "SemanticMatch",
    "SessionJoinedEvent",
    "SessionLeftEvent",
    "SettingsHoverDelayChangedEvent",
    "SettingsLocaleChangedEvent",
    "SettingsThemeChangedEvent",
    "Signal",
    "SmeltRebuildAnchorsCommand",
    "SmeltSettled",
    "SpecificResource",
    "Staging",
    "StatusResponse",
    "StorageUriEntry",
    "StoredEventResponse",
    "SupportedMediaType",
    "SvgSelector",
    "TagCategory",
    "TagSchema",
    "TagSchemaAddedPayload",
    "TagSchemasProjection",
    "Target",
    "TargetContext",
    "TextPositionSelector",
    "TextQuoteSelector",
    "TextualBody",
    "Timing",
    "UnderReported",
    "UnitCursor",
    "UpdateAnnotationBodyRequest",
    "UserResponse",
    "WeaveApplied",
    "WeaveRebuildCommand",
    "Workers",
    "YieldCloneCreateCommand",
    "YieldCloneCreated",
    "YieldClonePersistCommand",
    "YieldClonePersistOk",
    "YieldCloneResourceRequest",
    "YieldCloneTokenRequest",
    "YieldCreateCommand",
    "YieldCreateOk",
    "YieldMoveFailed",
    "YieldMvCommand",
    "YieldUpdateCommand",
    "YieldUpdateOk",
]


class AgentOrganization(WireModel, frozen=True, extra="allow"):
    """
    An organization — the Organization branch of Agent.
    """

    type: Annotated[Literal["Organization"], Field(alias="@type")]
    id: Annotated[str | None, Field(alias="@id")] = None
    name: str
    homepage: str | None = None


class AgentPerson(WireModel, frozen=True, extra="allow"):
    """
    A human participant — the Person branch of Agent.
    """

    type: Annotated[Literal["Person"], Field(alias="@type")]
    id: Annotated[
        str | None,
        Field(
            alias="@id",
            description="DID-shaped identifier (e.g. did:web:host:users:email%40host)",
        ),
    ] = None
    name: Annotated[
        str | None,
        Field(
            description="Display name. ABSENT until resolved: a Person is identified by `@id` and nothing else, and what they are called is recorded once per change on the knowledge base's own log and filled in when a record is read. An artifact therefore never freezes a name, which is what lets a correction reach every artifact its subject ever wrote. Absent also means genuinely unknown — a DID this knowledge base has no profile for."
        ),
    ] = None
    nickname: str | None = None
    email: str | None = None
    email_sha1: str | None = None
    homepage: str | None = None


class AgentSoftware(WireModel, frozen=True, extra="allow"):
    """
    A software peer (an inference model acting as a first-class participant) — the Software branch of Agent. Carries structured provider + model.
    """

    type: Annotated[Literal["Software"], Field(alias="@type")]
    id: Annotated[
        str | None,
        Field(
            alias="@id",
            description="DID-shaped identifier (e.g. did:web:host:agents:provider:model)",
        ),
    ] = None
    name: Annotated[
        str,
        Field(description="Stable human-friendly label. Not parsed; UI composes display from structured fields."),
    ]
    provider: Annotated[str | None, Field(description="Inference provider (e.g. ollama, anthropic)")] = None
    model: Annotated[
        str | None,
        Field(description="Model identifier (e.g. gemma2:27b, claude-3-5-sonnet)"),
    ] = None
    parameters: Annotated[
        dict[str, JsonValue] | None,
        Field(description="Inference parameters (temperature, maxTokens, systemPrompt, etc.). Runtime metadata, not part of identity."),
    ] = None


class Context(WireModel, frozen=True):
    before: str | None = None
    selected: str
    after: str | None = None


class AnnotationRemovedPayload(WireModel, frozen=True):
    """
    Payload for mark:removed domain event
    """

    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]


class BeckonFocusEvent(WireModel, frozen=True):
    """
    Emitted when an annotation receives focus for beckoning. resourceId is a guard, not navigation: it names the resource this focus applies to, and a viewer currently showing a different resource ignores the event — a deliberate ignore rather than a silent no-op. Focus never moves the viewer; driving the Browser to a resource is browse:resource-open's job.
    """

    annotation_id: Annotated[AnnotationId | None, Field(alias="annotationId")] = None
    resource_id: Annotated[
        ResourceId | None,
        Field(
            alias="resourceId",
            description="Guard: the resource this focus applies to. A viewer showing a different resource ignores the event. Never causes navigation.",
        ),
    ] = None


class BeckonHoverEvent(WireModel, frozen=True):
    """
    Emitted when an annotation is hovered over for beckoning
    """

    annotation_id: Annotated[AnnotationId | None, Field(alias="annotationId")]


class BeckonSparkleEvent(WireModel, frozen=True):
    """
    Emitted when a sparkle effect is triggered on an annotation
    """

    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]


class BindBodyUpdated(WireModel, frozen=True):
    """
    Void success reply emitted on the bind:body-updated channel after bind:update-body has been applied, matched to the originating command by correlationId.
    """


class BindInitiateCommand(WireModel, frozen=True):
    """
    Command payload sent on the bind:initiate bus channel to start a bind flow.
    """

    annotation_id: Annotated[
        AnnotationId,
        Field(
            alias="annotationId",
            description="Branded AnnotationId of the annotation being bound",
        ),
    ]
    resource_id: Annotated[
        ResourceId,
        Field(
            alias="resourceId",
            description="Branded ResourceId of the resource being bound to",
        ),
    ]
    default_title: Annotated[
        str,
        Field(alias="defaultTitle", description="Default title for the bound annotation"),
    ]
    entity_types: Annotated[
        list[str],
        Field(
            alias="entityTypes",
            description="Entity types to associate with the annotation",
        ),
    ]


type BodyPurpose = Annotated[
    Literal[
        "assessing",
        "bookmarking",
        "classifying",
        "commenting",
        "describing",
        "editing",
        "highlighting",
        "identifying",
        "linking",
        "moderating",
        "questioning",
        "replying",
        "tagging",
    ],
    Field(description="W3C Web Annotation body purpose vocabulary - https://www.w3.org/TR/annotation-vocab/#motivation"),
]


class BrowseAgentsRequest(WireModel, frozen=True):
    """
    Request to browse the KB's collaborator directory (its declared Agents)
    """


class BrowseAnnotationContextRequest(WireModel, frozen=True):
    """
    Request to get contextual text around an annotation
    """

    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    context_before: Annotated[int | None, Field(alias="contextBefore", ge=0, le=5000)] = None
    context_after: Annotated[int | None, Field(alias="contextAfter", ge=0, le=5000)] = None


class BrowseAnnotationHistoryRequest(WireModel, frozen=True):
    """
    Request to browse the history of an annotation
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]


class BrowseAnnotationRequest(WireModel, frozen=True):
    """
    Request to browse a single annotation
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]


class BrowseAnnotationsRequest(WireModel, frozen=True):
    """
    Request to browse annotations for a resource
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class BrowseClickEvent(WireModel, frozen=True):
    """
    An annotation was clicked — open it: the viewer selects its entry in the annotations panel and relays a focus signal to scroll to it. The annotation id is the whole address; it identifies exactly one annotation on exactly one resource, so no resource field is carried and none is needed to scope the event. Motivation is NOT on the wire either: the viewer derives it from the annotation the id names, so the wire states the fact once. A viewer that has not loaded that annotation finds nothing and does nothing. Emitted locally by every clickable annotation surface, and over the wire by a driver opening an annotation on another participant's screen.
    """

    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]


class BrowseDirectoryRequest(WireModel, frozen=True):
    """
    Request to browse a directory listing
    """

    path: str
    sort: Literal["name", "mtime", "annotationCount"] | None = None


class BrowseEntityTypeClickedEvent(WireModel, frozen=True):
    """
    Emitted when an entity type is clicked in the browse panel
    """

    entity_type: Annotated[str, Field(alias="entityType")]


class BrowseEntityTypesRequest(WireModel, frozen=True):
    """
    Request to browse available entity types
    """


class BrowseEventsRequest(WireModel, frozen=True):
    """
    Request to browse events for a resource
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    type: str | None = None
    user_id: Annotated[UserId | None, Field(alias="userId")] = None
    limit: int | None = None


class BrowseExternalNavigateEvent(WireModel, frozen=True):
    """
    Emitted when navigation to an external URL is requested
    """

    url: str
    resource_id: Annotated[ResourceId | None, Field(alias="resourceId")] = None


class BrowseKbRequest(WireModel, frozen=True):
    """
    Request for the knowledge base's description of itself
    """


class BrowseLinkClickedEvent(WireModel, frozen=True):
    """
    Emitted when a link is clicked in the browse panel
    """

    href: str
    label: str | None = None


class BrowsePanelToggleEvent(WireModel, frozen=True):
    """
    Emitted when a browse panel is toggled
    """

    panel: str


class BrowseResourceOpenEvent(WireModel, frozen=True):
    """
    Domain intent to open a resource in the viewer: emitted locally by in-app link handlers and remotely by the launcher's tour verbs; the viewer translates it to host routing (nav:push), which never crosses the wire. Deliberately not named 'navigate' — that word and the nav:* prefix belong to the host-local framework layer.
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class BrowseResourceViewedEvent(WireModel, frozen=True):
    """
    REPORT that a resource has loaded in a viewer — emitted on arrival by ANY means: a followed cue, an in-app link, the back button, a typed URL. Deliberately distinct from the imperative browse:resource-open: drive and report never share a channel, or the driver hears its own commands and one viewer's arrival steers another's page.
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class BrowseResourceCloseEvent(WireModel, frozen=True):
    """
    Emitted when a resource is closed in the browse panel
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class BrowseResourceReorderEvent(WireModel, frozen=True):
    """
    Emitted when resources are reordered in the browse panel
    """

    old_index: Annotated[int, Field(alias="oldIndex")]
    new_index: Annotated[int, Field(alias="newIndex")]


class PdfTextItem(WireModel, frozen=True):
    """
    One positioned text run. Coordinates are PDF points with the origin at the bottom-left of the page, Y increasing upward; the flip to canvas pixels happens in the browser.
    """

    start: Annotated[float, Field(description="Char offset into AnchoredText.text, inclusive.")]
    end: Annotated[float, Field(description="Char offset into AnchoredText.text, exclusive.")]
    page: Annotated[float, Field(description="1-indexed page number.")]
    x: float
    y: float
    width: float
    height: float


class BrowseAnchoredTextRequest(WireModel, frozen=True):
    """
    Request a resource's derived coordinate map — the text recovered from its bytes plus the geometry indexing it. Read-only: the Smelter is the sole producer and writes the anchored-text store directly, never over this channel.
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class AnchoredTextAbsent(WireModel, frozen=True):
    """
    There is no coordinate map to serve, and WHY — the distinction a bare null could not carry.

    One member covers all three absences because none carries a payload; `kind` alone is the fact. Retryability is legible from the name, deliberately: a caller must not need a lookup table to decide whether to come back.
    """

    kind: Annotated[
        Literal["not-yet", "no-map", "unknown"],
        Field(
            description="Discriminant, sharing the `kind` field with the ExtractedText/ExtractionDeclined members so the whole answer is one flat union.\n\n`not-yet` — the Smelter has not settled this content generation: the settle barrier expired, the progress fold was disposed, or it settled indexed and the artifact is missing (a loss the Smelter's reconcile pass re-derives). RETRY.\n\n`no-map` — the Smelter settled this resource as skipped: its media type derives no geometry, so a map will never exist. TERMINAL.\n\n`unknown` — no content identity to look up: the resource is not in the view store, or its primary representation carries no checksum. TERMINAL."
        ),
    ]


class BrowseResourceRequest(WireModel, frozen=True):
    """
    Request to browse a single resource
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class BrowseResourcesRequest(WireModel, frozen=True):
    """
    Request to browse resources with optional filtering and pagination
    """

    archived: bool | None = None
    entity_type: Annotated[str | None, Field(alias="entityType")] = None
    offset: int | None = None
    limit: int | None = None


class BrowseRouterPushEvent(WireModel, frozen=True):
    """
    Emitted when the browse panel requests a router navigation
    """

    path: str
    reason: str | None = None


class BrowseTagSchemasRequest(WireModel, frozen=True):
    """
    Request to browse registered tag schemas
    """


class BusEmitAccepted(WireModel, frozen=True):
    """
    Result of publishing one event. `subscribers` is the number of observers attached to the target subject at dispatch — the GLOBAL subject for an unscoped emit, the scoped one when `scope` is set. Zero means the signal reached nobody: /bus/subscribe enforces no channel allowlist and the emit handler publishes unconditionally, so a client can emit a channel no participant subscribes to and otherwise receive a clean 202 with no way to tell. Deliberately NOT named `delivered`: this is the count at dispatch, and a subscriber may still drop the frame downstream, so the field is named after what the server can actually observe.
    """

    subscribers: Annotated[
        int | None,
        Field(
            description='Observers on the target subject when the event was dispatched. ABSENT means the gateway could not count: under a broker signal plane (`[signal] type = "nats"`) the event is published to a fabric whose observers the gateway cannot see. The one zero a broker plane states is a registry operation\'s request with a `correlationId` that reached nobody, which the broker itself reports (no responders). Never defaulted: a zero here is the claim that nobody was listening, and a gateway that did not observe that never makes it.',
            ge=0,
        ),
    ] = None


class BusEmitRequest(WireModel, frozen=True):
    """
    One event for the bus. `channel` names a channel of the bus registry (specs/src/bus/registry.json) and `payload` must match the schema the registry's `validate` names for it. `scope` publishes a resource-bound broadcast to that resource's subscribers only; everything else is unscoped. `clientId` and `correlationId` are routing facts beside the payload, never inside it.
    """

    channel: Annotated[str, Field(description="A channel of the bus registry.", min_length=1)]
    payload: Annotated[
        dict[str, JsonValue],
        Field(
            description="The channel's payload, validated against the schema its registry entry names. `_userId` and `_roles` are the gateway's to write: whatever a caller puts there is replaced."
        ),
    ]
    scope: Annotated[
        ResourceId | None,
        Field(
            description="The resource scope of a resource-bound broadcast. Publishers of those broadcasts only; a command or request never carries one.",
            min_length=1,
        ),
    ] = None
    client_id: Annotated[
        str | None,
        Field(
            alias="clientId",
            description="The address this request's reply is delivered to: the emit claims `correlationId` for this clientId and the verified principal. Required when `channel` is a registry operation's request and a correlationId is present; ignored otherwise. An empty string counts as absent.",
        ),
    ] = None
    correlation_id: Annotated[
        str | None,
        Field(
            alias="correlationId",
            description="Pairs a reply with its request. On a registry operation's request it claims the id: a second claim of a live id is refused with 409. Replies carry it back on the frame, never in the payload.",
            min_length=1,
        ),
    ] = None


type GlobalItem = Annotated[str, Field(min_length=1)]


type PendingReply = Annotated[str, Field(min_length=1)]


type Channel = Annotated[str, Field(min_length=1)]


class ScopedItem(WireModel, frozen=True, extra="forbid"):
    scope: Annotated[ResourceId, Field(description="Resource scope (a resourceId).", min_length=1)]
    channels: Annotated[
        list[Channel],
        Field(description="Channels to subscribe within this scope.", min_length=1),
    ]
    last_event_id: Annotated[
        str | None,
        Field(
            alias="lastEventId",
            description="This scope's last-seen PersistedEventId. The gateway replays this scope's persisted events after it — those on the entry's channels — before the live tail, and writes a scoped `bus:resume-gap` (BusResumeGap) when it cannot cover the gap.",
        ),
    ] = None


class BusSubscribeRequest(WireModel, frozen=True, extra="forbid"):
    """
    Subscription matrix for the bus stream. `global` channels are delivered unscoped; each `scoped` entry subscribes the connection to one resource scope's channels, optionally resuming from that scope's last-seen persisted event id. At least one global channel or one scoped entry is required, and no scope may appear in two entries.
    """

    global_: Annotated[
        list[GlobalItem] | None,
        Field(alias="global", description="Unscoped channels to subscribe to."),
    ] = None
    pending_replies: Annotated[
        list[PendingReply] | None,
        Field(
            alias="pendingReplies",
            description="Correlation ids of requests this client still awaits a reply to. The gateway writes every reply it still retains for them (for `x-semiont-limits.replyRetentionSeconds` after it was published) as an ordinary frame with its ReplyEventId, so a reply that also arrived live dedups client-side. A client can have no more pending than it may have unanswered requests, so this bound is also the number of unanswered requests `POST /bus/emit` allows a client.",
            max_length=256,
        ),
    ] = None
    scoped: Annotated[
        list[ScopedItem] | None,
        Field(
            description="Per-resource-scope subscriptions, at most 512 on one connection. Scopes must be unique across entries.",
            max_length=512,
        ),
    ] = None
    client_id: Annotated[
        str,
        Field(
            alias="clientId",
            description="Routing address for correlated replies: a UUID minted once per bus-client lifetime — per actor, not per connection, so it survives a reconnect and two overlapping connections share it. A correlated reply is delivered to a connection only when its request was emitted under the same clientId by the same principal. Not authentication — the bearer token stays that — and never echoed into any payload or broadcast frame.",
            min_length=1,
        ),
    ]


class CommandError(WireModel, frozen=True):
    """
    Error response for failed bus commands. Replaces native Error objects on the EventBus so payloads are serializable and OpenAPI-typed.
    """

    code: Annotated[
        Literal["peer-unavailable", "not-found", "unauthorized", "none-pending"] | None,
        Field(
            description="Machine-readable failure class, for consumers that must BRANCH on why a command failed rather than log it. Optional and deliberately sparse: absent means 'no class declared', and every existing failure stays that way. An enum rather than a free string so the vocabulary has an owner — an unconstrained code is a mirror with no gate, and adding one should be a deliberate spec change. `message` remains the human-readable text and is unaffected. Members: `peer-unavailable` — the channel this command was sent on has no subscriber, i.e. the service that answers it has not connected yet. Transient by nature (a peer still starting), which is what distinguishes it from a refusal: retrying is the correct response. `not-found` — the resource this command addressed does not exist in this knowledge base. A verdict, not a symptom: it is emitted only where the answer comes from the event store, which is the system of record, and never from a projection that may merely be lagging. Deterministic, so unlike `peer-unavailable` retrying is pointless — and consumers may act destructively on it (the SDK deletes a restored tab). Absence is not denial: a future 'exists, but not for you' must travel as its own code, never as this one. `unauthorized` — that code: the caller is authenticated but not permitted to do what it asked. A verdict about the CALLER, not the resource, so retrying under the same credential cannot succeed and a consumer must never spin on it; emitted by `job:claim` for a caller whose token carries no worker role. `none-pending` — a declined claim, not an error: the queue holds no pending job of the requested types. Nothing went wrong; the one code a consumer PARKS on, meaning 'nothing to do until a wake-up'. Emitted by `job:claim` only. A `job:claim` refusal carrying neither is unclassified — a malformed record or a missing injection — and a consumer treats it as 'log it, assume nothing'."
        ),
    ] = None
    message: Annotated[str, Field(description="Human-readable error message")]
    details: Annotated[
        str | None,
        Field(description="Optional additional context (stack trace, field name, etc.)"),
    ] = None


type ContentFormat = Annotated[
    str,
    Field(
        description="Content format as a MIME type, optionally with parameters. The base type (everything before the first ';') MUST be a SupportedMediaType; parameters such as charset are preserved as metadata. Semantic validation happens in code at the create/yield boundary — there is deliberately no pattern here, the vocabulary lives in SupportedMediaType. Examples: text/plain, text/plain; charset=iso-8859-1, text/markdown; charset=windows-1252, image/png, application/pdf",
        examples=["text/plain; charset=utf-8"],
    ),
]


class ContextualSummaryResponse(WireModel, frozen=True):
    summary: str
    relevant_fields: Annotated[dict[str, JsonValue], Field(alias="relevantFields")]
    context: Context


class CreateResourceResponse(WireModel, frozen=True):
    """
    The id of the resource an upload created. The Archivist answers it (200) once it has stored the bytes and recorded the resource, and the gateway forwards it (202), so the id is the one the record minted and its creation event is persisted. What remains asynchronous is downstream projection: graph, views and vectors settle afterwards.
    """

    resource_id: Annotated[
        ResourceId,
        Field(
            alias="resourceId",
            description="The id of the newly created resource, as the record minted it.",
        ),
    ]


class DirEntry(WireModel, frozen=True, extra="forbid"):
    type: Literal["dir"]
    name: Annotated[str, Field(description="Entry name (basename)")]
    path: Annotated[str, Field(description="Path relative to project root")]
    mtime: Annotated[str, Field(description="Last modified time (ISO 8601)")]


class DiscoveredKB(WireModel, frozen=True):
    """
    One knowledge base the Semiont launcher manages on this machine, as published in the discovery document (see DiscoveryDocument). Endpoints and identity only — never credentials; login remains the consumer's per-KB business.
    """

    host: Annotated[
        str,
        Field(
            description='Hostname the KB is reachable on from this machine (always "localhost" — local stacks bind locally and codespace KBs arrive through a local port forward)'
        ),
    ]
    port: Annotated[
        int,
        Field(
            description="Local TCP port of the KB's API (the gateway port for a local stack; the allocated forward port for a codespace stack)"
        ),
    ]
    placement: Annotated[
        Literal["local", "codespace"],
        Field(
            description='Where the stack actually runs. "local": containers on this machine. "codespace": a GitHub-hosted VM whose KB is port-forwarded here.'
        ),
    ]
    repo: Annotated[
        str | None,
        Field(description="owner/name GitHub slug — present for codespace placements, where the repo is the stack's identity"),
    ] = None
    did: Annotated[
        str,
        Field(
            description='The KB\'s did:web identifier, from its committed .semiont/config — "did:web:" + the [site] domain, verbatim. REQUIRED: a KB that declares no domain has no identity to publish, and the launcher refuses to start it rather than inventing or defaulting one. NOT unique within a document: a did names the knowledge base, not a running copy of it, so a local clone and a codespace of the same repo legitimately share one and both are published. host:port is the unique field (at most one entry per address), so consumers look up by ADDRESS and use the did to VERIFY that the copy they reached is the KB they meant — an address alone cannot say which KB is which, and an identity alone cannot say which copy.'
        ),
    ]
    site_name: Annotated[
        str | None,
        Field(
            alias="siteName",
            description="Human-readable site name from the KB's .semiont/config, for display",
        ),
    ] = None
    managed_by: Annotated[
        str,
        Field(
            alias="managedBy",
            description='The agent that owns this entry\'s lifecycle (the launcher writes "semiont-launcher"). Consumers treat managed entries as authoritative for themselves — upsert on appearance, remove on disappearance — and never touch entries they did not write.',
        ),
    ]


class DiscoveryDocument(WireModel, frozen=True):
    """
    The launcher's KB discovery document — the schema authority for <stateDir>/discovery/kbs.json, which the semiont launcher (Go, apps/launcher) regenerates on every stack mutation and the Browser container mounts read-only at /discovery. NOT an API endpoint: a static document fetched same-origin by browsers (via the Browser's static server) or read from disk by local Node consumers. An empty kbs list is meaningful ("the launcher manages nothing right now") and distinct from an absent file.
    """

    version: Annotated[
        Literal[1],
        Field(description="Document schema version. Consumers MUST check it and ignore documents they do not understand."),
    ]
    kbs: Annotated[
        list[DiscoveredKB],
        Field(description="Every KB the launcher currently manages, local and forwarded"),
    ]


class EntityTagChangedPayload(WireModel, frozen=True):
    """
    Payload for mark:entity-tag-added and mark:entity-tag-removed domain events
    """

    entity_type: Annotated[str, Field(alias="entityType")]


class EntityTypeAddedPayload(WireModel, frozen=True):
    """
    Payload for frame:entity-type-added domain event (system-level, no resourceId — fan-out is global)
    """

    entity_type: Annotated[str, Field(alias="entityType")]


class ErrorResponse(WireModel, frozen=True):
    """
    The body of every error the gateway answers, whatever the status and whatever the route — including a path it does not serve.
    """

    error: Annotated[str, Field(description="What went wrong, in a sentence.")]
    code: Annotated[
        str | None,
        Field(description="A machine-readable class, when the route defines one."),
    ] = None
    hint: Annotated[
        str | None,
        Field(description="What the caller can do about it, when there is something to say."),
    ] = None
    details: JsonValue | None = None


class EventMetadata(WireModel, frozen=True):
    """
    Metadata added at persistence time. Part of every StoredEvent. Integrity is provided by git at the commit level (when gitSync is enabled), not by in-event metadata fields.
    """

    sequence_number: Annotated[
        int,
        Field(
            alias="sequenceNumber",
            description="Monotonic position in the event log (ordering authority)",
        ),
    ]


class OcrConfidence(WireModel, frozen=True):
    """
    How well the engine read the pixels, when any of this text came from OCR.
    """

    mean: Annotated[float, Field(description="Mean per-word confidence, 0-100.")]
    low_confidence_words: Annotated[
        int,
        Field(alias="lowConfidenceWords", description="Words the engine was unsure of."),
    ]
    total_words: Annotated[int, Field(alias="totalWords")]


class ExtractionDeclined(WireModel, frozen=True):
    """
    A named decline: extraction ran and yielded nothing, by class. A first-class, cacheable outcome — 'we ran and there was nothing' costs a full recognition pass to discover.
    """

    kind: Annotated[
        Literal["declined"],
        Field(
            description="Discriminant — both ExtractionOutcome members carry `kind`, single-valued: the category here, the detail in `declined`."
        ),
    ]
    declined: Annotated[
        Literal["no-text-layer", "encrypted", "corrupt", "too-large"],
        Field(description="Why extraction yielded nothing, by class."),
    ]


class FileEntry(WireModel, frozen=True, extra="forbid"):
    type: Literal["file"]
    name: Annotated[str, Field(description="Entry name (basename)")]
    path: Annotated[str, Field(description="Path relative to project root")]
    size: Annotated[int, Field(description="File size in bytes")]
    mtime: Annotated[str, Field(description="Last modified time (ISO 8601)")]
    tracked: Annotated[
        bool,
        Field(description="True if this file is a tracked resource in the Knowledge Base"),
    ]
    resource_id: Annotated[
        ResourceId | None,
        Field(alias="resourceId", description="Resource ID (only when tracked is true)"),
    ] = None
    entity_types: Annotated[
        list[str] | None,
        Field(
            alias="entityTypes",
            description="Entity types assigned to this resource (only when tracked is true)",
        ),
    ] = None
    annotation_count: Annotated[
        int | None,
        Field(
            alias="annotationCount",
            description="Number of annotations on this resource (only when tracked is true)",
        ),
    ] = None
    creator: Annotated[
        str | None,
        Field(
            description="DID of the resource's creator — the first of its derived `wasAttributedTo`, the requester as the knowledge base recorded it (only when tracked is true)"
        ),
    ] = None


class FragmentSelector(WireModel, frozen=True):
    """
    W3C Web Annotation FragmentSelector for media fragment identifiers (RFC 3778 for PDFs)
    """

    type: Literal["FragmentSelector"]
    value: Annotated[
        str,
        Field(
            description="Media fragment identifier (e.g., 'page=1&viewrect=100,200,50,30' for PDF)",
            examples=["page=1&viewrect=100,200,50,30"],
        ),
    ]
    conforms_to: Annotated[
        str | None,
        Field(
            alias="conformsTo",
            description="URI identifying the fragment syntax specification",
            examples=["http://tools.ietf.org/rfc/rfc3778"],
        ),
    ] = None


class FrameAddEntityTypeCommand(WireModel, frozen=True):
    """
    Bus command to add a new entity type to the KB's vocabulary. Carried on the `frame:add-entity-type` channel — Frame is the schema-layer flow that owns vocabulary writes.
    """

    tag: str
    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None


class GatherAnnotationOptions(WireModel, frozen=True):
    """
    Optional configuration for an annotation-focus gather, which windows text around a mark. Distinct from the resource-focus options (depth / maxResources / includeContent / includeSummary), which traverse the resource graph.
    """

    include_source_context: Annotated[
        bool | None,
        Field(
            alias="includeSourceContext",
            description="Whether to include source context in the gathered result",
        ),
    ] = None
    include_target_context: Annotated[
        bool | None,
        Field(
            alias="includeTargetContext",
            description="Whether to include target context in the gathered result",
        ),
    ] = None
    context_window: Annotated[
        int | None,
        Field(
            alias="contextWindow",
            description="Characters of surrounding text context to include",
        ),
    ] = None


class GatherAnnotationRequest(WireModel, frozen=True):
    """
    Request payload sent on the gather:requested bus channel to gather context for an annotation.
    """

    annotation_id: Annotated[
        AnnotationId,
        Field(
            alias="annotationId",
            description="Branded AnnotationId of the annotation to gather context for",
        ),
    ]
    resource_id: Annotated[
        ResourceId,
        Field(
            alias="resourceId",
            description="Branded ResourceId of the resource the annotation belongs to",
        ),
    ]
    options: GatherAnnotationOptions | None = None


class Options(WireModel, frozen=True):
    """
    Gathering configuration
    """

    depth: Annotated[int, Field(description="Depth of resource graph traversal")]
    max_resources: Annotated[
        int,
        Field(
            alias="maxResources",
            description="Maximum number of related resources to include",
        ),
    ]
    include_content: Annotated[
        bool,
        Field(
            alias="includeContent",
            description="Whether to include resource content in the gathered result",
        ),
    ]
    include_summary: Annotated[
        bool,
        Field(
            alias="includeSummary",
            description="Whether to include resource summaries in the gathered result",
        ),
    ]
    exclude_entity_types: Annotated[
        list[str] | None,
        Field(
            alias="excludeEntityTypes",
            description="Entity types to exclude from the semantic recall built into this context (caller-supplied; e.g. a chat consumer passes ['Question'] so prior questions never ground answer generation). Optional; default none.",
        ),
    ] = None


class GatherResourceRequest(WireModel, frozen=True):
    """
    Request payload sent on the gather:resource-requested bus channel to gather context for a resource.
    """

    resource_id: Annotated[
        ResourceId,
        Field(
            alias="resourceId",
            description="Branded ResourceId of the resource to gather context for",
        ),
    ]
    options: Annotated[Options, Field(description="Gathering configuration")]


class GatherSummaryRequest(WireModel, frozen=True):
    """
    Request to generate an AI summary of an annotation
    """

    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class GatherReferencedByRequest(WireModel, frozen=True):
    """
    Request for the annotations elsewhere that refer to a resource. The Librarian answers from the graph.
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    motivation: str | None = None


type DurabilityEvidence = Annotated[
    Literal["acknowledged", "probe-confirmed", "probe-refused", "probe-unreachable"],
    Field(
        description="How a job's annotations were established as durable — the OBSERVATION, never a conclusion drawn from it. 'acknowledged': the event log confirmed the batch (mark:commit-ok). 'probe-confirmed': the acknowledgement was lost and a later read found the batch's last annotation present — true, but a weaker claim than an ack, since it rests on the log appending a batch in order and stopping at the first failure. 'probe-refused': the read returned a failure reply; note this does NOT assert the annotations are absent, because a read that failed for its own reasons answers on the same channel. 'probe-unreachable': no answer came at all, so nothing was established either way. ABSENT means the question never arose — a job that committed no annotations. Never defaulted: a manufactured value here is a claim nobody made, in a log nobody can rewrite."
    ),
]


type FailureClass = Annotated[
    Literal["transient", "deterministic"],
    Field(
        description="Worker-side classification of a job failure, made where the error is still typed (at the gateway it is already a flattened string, and message-regex classification is the drift this exists to avoid). 'deterministic' — the same request cannot succeed on a second attempt — skips the retry budget. ABSENT means unrecognised, which is deliberately not the same claim as 'transient': only KNOWN-deterministic failures carry the class, because mis-reading a transient failure as deterministic halves reliability while the reverse costs one wasted attempt."
    ),
]


class Selected(WireModel, frozen=True):
    """
    Text context around the annotation target
    """

    before: Annotated[str | None, Field(description="Text appearing before the selected passage")] = None
    text: Annotated[str, Field(description="The selected text passage (the annotation target)")]
    after: Annotated[str | None, Field(description="Text appearing after the selected passage")] = None


class TargetContext(WireModel, frozen=True):
    """
    Context about the annotation's link target. Dormant — produced/exposed but not yet consumed.
    """

    content: str
    summary: str | None = None


class Content(WireModel, frozen=True):
    """
    Resource content (included when requested)
    """

    main: Annotated[str | None, Field(description="Content of the focal resource")] = None
    related: Annotated[
        dict[str, str] | None,
        Field(description="Map of related resource IDs to their content"),
    ] = None


class Metadata(WireModel, frozen=True):
    """
    Context metadata about the focal anchor and its source
    """

    resource_type: Annotated[
        str | None,
        Field(
            alias="resourceType",
            description="Type of source resource (e.g., 'document', 'image', 'video')",
        ),
    ] = None
    language: Annotated[str | None, Field(description="BCP 47 language tag of source content")] = None
    entity_types: Annotated[
        list[str] | None,
        Field(
            alias="entityTypes",
            description="Entity types associated with the focal anchor",
        ),
    ] = None
    entity_type_frequencies: Annotated[
        dict[str, int] | None,
        Field(
            alias="entityTypeFrequencies",
            description="Global frequency counts for entity types (for IDF-like weighting). A KB-wide statistic, not a neighborhood property — kept here rather than on the graph.",
        ),
    ] = None


class GetEntityTypesResponse(WireModel, frozen=True):
    entity_types: Annotated[list[str], Field(alias="entityTypes")]


class Selector1(WireModel, frozen=True):
    exact: Annotated[str, Field(description="The selected text that references this resource")]


class Target(WireModel, frozen=True):
    source: Annotated[ResourceId, Field(description="ID of resource containing the reference")]
    selector: Selector1


class ReferencedByItem(WireModel, frozen=True):
    id: Annotated[AnnotationId, Field(description="Reference annotation ID")]
    resource_name: Annotated[
        str,
        Field(
            alias="resourceName",
            description="Name of resource containing the reference",
        ),
    ]
    target: Target


class GetReferencedByResponse(WireModel, frozen=True):
    referenced_by: Annotated[list[ReferencedByItem], Field(alias="referencedBy")]


class HealthResponse(WireModel, frozen=True):
    """
    Liveness: the process is up and serving. It asks nothing of the Archivist or the broker — a gateway that cannot reach them refuses to start, so one that answers here got past both at boot.
    """

    status: str
    message: str
    version: str
    timestamp: str


class InferenceLimits(WireModel, frozen=True):
    """
    A provider's actual ceilings for a model, discovered from the provider itself (Anthropic Models API; Ollama /api/show) — never hand-maintained constants. Semantics differ by provider shape: Anthropic reports maximum input tokens in contextTokens with a separate output ceiling in maxOutputTokens; Ollama reports the shared input+output window and mirrors it into both fields (there is no separate output ceiling), so maxOutputTokens === contextTokens signals a shared window.
    """

    context_tokens: Annotated[
        float,
        Field(
            alias="contextTokens",
            description="The context window in tokens. Anthropic: maximum input tokens (output has its own ceiling). Ollama: the shared input+output window.",
        ),
    ]
    max_output_tokens: Annotated[
        float,
        Field(
            alias="maxOutputTokens",
            description="Maximum output tokens per generation. Equal to contextTokens when the provider has a single shared window.",
        ),
    ]
    accepts_temperature: Annotated[
        bool | None,
        Field(
            alias="acceptsTemperature",
            description="Whether this agent's model accepts a caller-supplied sampling temperature, measured against the provider (Anthropic: an active probe at discovery, because some models reject the parameter outright and the Models API does not say; Ollama: always true). Consumers treat only an explicit false as 'hide temperature controls' — absence means no claim.",
        ),
    ] = None


class InferenceLimitsRequest(WireModel, frozen=True):
    """
    Request for the inference limits of the (provider, model) pairs one service holds a client for. Answered on job:limits-requested by the worker, and on gather:limits-requested and match:limits-requested by the librarian: each service that holds an inference credential reports for its own pairs, so no other service needs one.
    """


class InferencePairLimits(WireModel, frozen=True):
    """
    The discovered limits of one (provider, model) pair.
    """

    provider: Annotated[
        str,
        Field(description="The inference provider, as the KB config names it (e.g. anthropic, ollama)."),
    ]
    model: Annotated[str, Field(description="The model identifier, as the KB config names it.")]
    limits: InferenceLimits


class GraphResourceNode(WireModel, frozen=True):
    """
    A resource's presence in the gathered knowledge graph.
    """

    id: Annotated[ResourceId, Field(description="The resource's ResourceId")]
    type: Literal["resource"]
    label: Annotated[
        str,
        Field(description="The resource's display name — its raw id when the resource's view was missing at build time"),
    ]
    entity_types: Annotated[
        list[str] | None,
        Field(alias="entityTypes", description="Entity types on the resource"),
    ] = None
    metadata: dict[str, JsonValue] | None = None


class JobAssessmentAnnotationResult(WireModel, frozen=True):
    """
    Result of a completed assessment-annotation job.
    """

    kind: Annotated[
        Literal["assessment-annotation"],
        Field(
            description="Discriminant — every JobResult member carries `kind`, single-valued, so a consumer holding only the result can tell what it is."
        ),
    ]
    assessments_found: Annotated[int, Field(alias="assessmentsFound")]
    assessments_created: Annotated[int, Field(alias="assessmentsCreated")]


class JobCancelRequest(WireModel, frozen=True):
    """
    Request to cancel a job. Target one running or pending job by `jobId`, or a whole category of pending jobs by `jobType`. A `jobId`-targeted request that names a RUNNING job is honoured cooperatively by the owning worker, which stops at its next unit boundary and emits JobCancelCommand — the queue is never made to yank a running job out from under a live worker.
    """

    job_id: Annotated[
        JobId | None,
        Field(
            alias="jobId",
            description="Cancel this one job. A pending job is cancelled immediately by the dispatcher; a running job is cancelled cooperatively by its worker. Takes precedence over jobType.",
        ),
    ] = None
    job_type: Annotated[
        Literal["annotation", "generation"] | None,
        Field(
            alias="jobType",
            description="Cancel all PENDING jobs in this category — the bulk UI signal. Ignored when jobId is present.",
        ),
    ] = None


class JobClaimCommand(WireModel, frozen=True):
    """
    Claim the NEXT pending job matching one of the requested types (atomic: pending → running). Claim-by-type replaced claim-by-jobId: a job:queued announcement is a WAKE-UP, not a reservation — the claimed job may differ from the announced one, and two workers claiming after one announcement both succeed on different jobs instead of racing for one. An empty `types` accepts any type. The reply channels are unchanged: job:claimed carries the claimed job; job:claim-failed reports nothing-available exactly as it reported already-claimed.
    """

    types: list[str]
    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated claimant's DID, injected by the /bus/emit gateway. Clients do not set this. The dispatcher records it as the holder on job:assigned.",
        ),
    ] = None
    roles: Annotated[
        list[str] | None,
        Field(
            alias="_roles",
            description="The claimant's capabilities (the token's `roles`), injected by the /bus/emit gateway. Clients do not set this. The dispatcher authorizes the claim by capability — it admits the claim only when this carries the worker role — so a claimant that is not a worker for this knowledge base is refused before the queue is consulted.",
        ),
    ] = None


class JobCommentAnnotationResult(WireModel, frozen=True):
    """
    Result of a completed comment-annotation job.
    """

    kind: Annotated[
        Literal["comment-annotation"],
        Field(
            description="Discriminant — every JobResult member carries `kind`, single-valued, so a consumer holding only the result can tell what it is."
        ),
    ]
    comments_found: Annotated[int, Field(alias="commentsFound")]
    comments_created: Annotated[int, Field(alias="commentsCreated")]


class Response3(WireModel, frozen=True):
    job_id: Annotated[JobId, Field(alias="jobId")]


class JobCreatedResult(WireModel, frozen=True):
    """
    Result of a job:create command
    """

    response: Response3


class UnitCursor(WireModel, frozen=True):
    """
    How far a single unit got, for a resume that starts mid-unit rather than redoing it. A unit is an entity type for reference-annotation, and the job's own motivation for the other annotation types — which is why a unit-grain checkpoint alone was too coarse: those jobs have exactly one unit, so nothing could be recorded until the whole document was done.

    MERGE IS MONOTONE PER UNIT, not a union. `completedUnits` is a set and converges under concurrent snapshots because a set only grows; a cursor converges only if a stale snapshot can never move it backward.

    IT CARRIES THE UNIT'S RUNNING TALLIES TOO, and they are required. A resumed unit counts only the chunks it actually runs, so without them a retry's terminal record reports the remainder of the document as if it were the whole — measured at totalFound 19 where the document yielded 25. The position and the tallies are ONE observation of the same committed chunk; splitting them would let a resume take the saving and still report a number nobody can trust.
    """

    next: Annotated[
        int,
        Field(
            description="Characters consumed once the last COMMITTED chunk completed — the resume position. Deliberately the chunk's `next`, never its `at`: the checkpoint must not lead the log, so it records where a chunk that is already durable ended, not where the in-flight one began. Recording `at` would make a resume re-run the chunk it already paid for.",
            ge=0,
        ),
    ]
    size: Annotated[
        int,
        Field(
            description="The token size that last committed chunk was cut at — the calibration the attempt paid for over the chunks before it. A resume seeds from this and then takes ONE adaptive step, as if the last outcome were a failure, which it was: the job died. Seeding alone would re-cut the failing piece identically; opening at the default would discard the calibration.",
            ge=1,
        ),
    ]
    found: Annotated[
        int,
        Field(
            description="Items detection has returned for this unit through the last committed chunk — the numerator a resumed attempt continues from rather than restarting at zero. Counts what the model reported, before dedupe.",
            ge=0,
        ),
    ]
    emitted: Annotated[
        int,
        Field(
            description="Annotations actually committed for this unit through the last committed chunk, after dedupe. The pair (found, emitted) is what the job's terminal result reports, so a resumed unit seeds both and its record describes the whole document rather than one attempt's share.",
            ge=0,
        ),
    ]


class JobDeclinedResult(WireModel, frozen=True):
    """
    Result of a job that completed without doing its work because the resource could not be read. Distinct from a failure: nothing went wrong, there was simply no text to work with — an encrypted or damaged PDF, a scan whose text could not be recognized, or a document that yielded nothing. The reasons are the extraction vocabulary the Smelter reports on `smelt:settled`, MINUS `no-extractor`: a media type that can never yield text (a zip, an image) is a bad request rather than a decline, so a worker asked to detect over one throws and the job reports `job:fail`. Everything here is a resource-specific outcome — the same media type would have succeeded on a different document.
    """

    kind: Annotated[
        Literal["declined"],
        Field(
            description="Discriminant — every JobResult member carries `kind`, single-valued, so a consumer holding only the result can tell what it is."
        ),
    ]
    declined: Annotated[
        Literal[True],
        Field(description="Discriminant. Always true — a job that did its work reports one of the other result shapes."),
    ]
    reason: Annotated[
        Literal["no-text-layer", "encrypted", "corrupt", "too-large", "empty"],
        Field(
            description="Why the resource could not be read. A CODE, not a sentence: the client owns the wording, so a browser renders it in the user's language and the CLI renders English terminal copy from the same value. A prose `message` composed server-side would be English everywhere."
        ),
    ]


class JobGenerationResult(WireModel, frozen=True):
    """
    Result of a completed generation job. The worker creates the resource first (the yield:create round-trip returns the id), then emits job:complete carrying it — so resourceId is always present on the wire.
    """

    kind: Annotated[
        Literal["generation"],
        Field(
            description="Discriminant — every JobResult member carries `kind`, single-valued, so a consumer holding only the result can tell what it is."
        ),
    ]
    resource_id: Annotated[
        ResourceId,
        Field(
            alias="resourceId",
            description="ID of the generated resource, obtained by the worker from the create round-trip before job:complete is emitted",
        ),
    ]
    resource_name: Annotated[str, Field(alias="resourceName", description="Name of the generated resource")]
    truncated: Annotated[
        bool,
        Field(
            description="True when the model stopped at the maxTokens ceiling — the artifact is cut off, not complete. Derived at the producer from the provider's stopReason ('max_tokens' → true); required because the worker always knows."
        ),
    ]


class JobHighlightAnnotationResult(WireModel, frozen=True):
    """
    Result of a completed highlight-annotation job.
    """

    kind: Annotated[
        Literal["highlight-annotation"],
        Field(
            description="Discriminant — every JobResult member carries `kind`, single-valued, so a consumer holding only the result can tell what it is."
        ),
    ]
    highlights_found: Annotated[int, Field(alias="highlightsFound")]
    highlights_created: Annotated[int, Field(alias="highlightsCreated")]


class Current(WireModel, frozen=True):
    """
    What the run is working on right now. `kind` is a CODE the client renders a localized name for; `value` is KB data (an entity type, a tag category) shown verbatim — the same split as `requestParams`. Absent on flows that iterate nothing, such as generation.
    """

    kind: Annotated[
        Literal["entity-type", "category"],
        Field(description="What sort of thing `value` is. Adding a variant means adding client copy for it in every locale."),
    ]
    value: Annotated[str, Field(description="The item itself, shown verbatim and never translated.")]


class UnderReported(WireModel, frozen=True):
    """
    Present only when pieces of this unit were accepted at the subdivision floor while a count call said more was present. The unit completed, but incompletely — this carries the EVIDENCE (found vs counted, over how many pieces), never a judgment against any expected yield. Absent means complete: genuinely absent, not defaulted.
    """

    pieces: Annotated[int, Field(description="Floor-accepted pieces in this unit.")]
    found: Annotated[
        int,
        Field(description="Annotations extraction did find on those pieces — every span write-time-verified."),
    ]
    counted: Annotated[
        int,
        Field(description="Mentions the count calls reported across those pieces (approximate by nature)."),
    ]


class CompletedItem(WireModel, frozen=True):
    value: Annotated[str, Field(description="The item, shown verbatim.")]
    found_count: Annotated[int, Field(alias="foundCount", description="Annotations found for it.")]
    persisted_count: Annotated[
        int | None,
        Field(
            alias="persistedCount",
            description="Annotations actually persisted for it — post-dedupe and post-durability-acknowledgement, so it counts what the event log holds, not what the model proposed. Beside foundCount this is the per-unit yield the sizing work is judged by. Present on flows whose units persist as they complete (reference-annotation); the tagging flow reports the same fact as byCategory on its result, because its annotations are built after the per-category loop.",
        ),
    ] = None
    under_reported: Annotated[
        UnderReported | None,
        Field(
            alias="underReported",
            description="Present only when pieces of this unit were accepted at the subdivision floor while a count call said more was present. The unit completed, but incompletely — this carries the EVIDENCE (found vs counted, over how many pieces), never a judgment against any expected yield. Absent means complete: genuinely absent, not defaulted.",
        ),
    ] = None


class RequestParam(WireModel, frozen=True):
    label: Annotated[
        Literal["entity-types", "instructions", "tone", "density"],
        Field(description="Which parameter this is. The client renders a localized name for it."),
    ]
    value: Annotated[str, Field(description="The user's own input, shown verbatim.")]


class JobProgressAnalyzing(WireModel, frozen=True):
    """
    Analyzing the content.
    """

    code: Literal["analyzing"]


class JobProgressAnalyzingTags(WireModel, frozen=True):
    """
    Analyzing the content against the tag schema.
    """

    code: Literal["analyzing-tags"]


class JobProgressCompleteCreated(WireModel, frozen=True):
    """
    Terminal success summary.
    """

    code: Literal["complete-created"]
    count: Annotated[int, Field(description="How many annotations were created")]
    kind: Annotated[
        Literal["highlight", "comment", "assessment", "reference", "tag"],
        Field(description="What kind of annotation was created; clients pluralize/translate"),
    ]


class JobProgressCompleteGenerated(WireModel, frozen=True):
    """
    Generation's terminal success. Deliberately generic — the client already holds the title it typed, and the outcome (name + resource link) travels on job:complete, not on progress. `truncated` qualifies the completion: the same bit `JobGenerationResult.truncated` carries, so the two surfaces cannot drift.
    """

    code: Literal["complete-generated"]
    truncated: Annotated[
        bool,
        Field(description="True when the model stopped at the maxTokens ceiling — the artifact is cut off, not complete."),
    ]


class JobProgressCreatingAnnotations(WireModel, frozen=True):
    """
    Writing detected annotations back to the resource.
    """

    code: Literal["creating-annotations"]
    count: Annotated[int, Field(description="How many annotations are being created")]


class JobProgressCreatingResource(WireModel, frozen=True):
    """
    Writing the generated resource.
    """

    code: Literal["creating-resource"]


class JobProgressCreatingTagAnnotations(WireModel, frozen=True):
    """
    Writing detected tag annotations back to the resource.
    """

    code: Literal["creating-tag-annotations"]
    count: Annotated[int, Field(description="How many annotations are being created")]


class JobProgressDetectingEntities(WireModel, frozen=True):
    """
    Entity detection, one entity type at a time.
    """

    code: Literal["detecting-entities"]
    entity_type: Annotated[
        str,
        Field(alias="entityType", description="Entity type currently being detected"),
    ]


class JobProgressGeneratingResource(WireModel, frozen=True):
    """
    The model is generating the resource.
    """

    code: Literal["generating-resource"]


class JobProgressLoading(WireModel, frozen=True):
    """
    Loading the resource content.
    """

    code: Literal["loading"]


class JobQueuedEvent(WireModel, frozen=True):
    """
    Event indicating a job has been queued
    """

    job_id: Annotated[JobId, Field(alias="jobId")]
    job_type: Annotated[str, Field(alias="jobType")]
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    user_id: Annotated[
        UserId,
        Field(alias="userId", description="DID of the user who initiated the job (audit)."),
    ]


class JobReferenceAnnotationResult(WireModel, frozen=True):
    """
    Result of a completed reference-annotation job.
    """

    kind: Annotated[
        Literal["reference-annotation"],
        Field(
            description="Discriminant — every JobResult member carries `kind`, single-valued, so a consumer holding only the result can tell what it is."
        ),
    ]
    total_found: Annotated[int, Field(alias="totalFound", description="Total entities found")]
    total_emitted: Annotated[int, Field(alias="totalEmitted", description="Total annotations emitted")]
    errors: Annotated[int, Field(description="Number of errors encountered")]
    under_reported_pieces: Annotated[
        int | None,
        Field(
            alias="underReportedPieces",
            description="Total floor-accepted under-reported pieces across the job's units. Absent means none — the per-unit evidence rides the terminal progress frame's completedItems; this keeps the result self-describing without the progress stream.",
        ),
    ] = None


class PersonProfileCommand(WireModel, frozen=True):
    """
    Bus command the gateway emits when a person ACTS, carrying the display name it just verified on their token. The Stower persists it as person:profiled, and only when the name differs from the latest one recorded for that DID — so the log holds one line per name a subject has had, not one per act. A name is a fact ABOUT an identity, never part of the record of an act: no artifact carries it, and readers resolve it from the people projection. Emitted only for a person (an issuer token); an agent token never produces one, and neither does a request that merely reads.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="The person's DID, injected by the /bus/emit gateway from the verified token. Clients do not set this.",
        ),
    ] = None
    name: Annotated[
        str,
        Field(
            description="The display name from the issuer's `name` claim, as verified on the token that carried this act. A token with no name produces no command at all — the issuer is where a name is set, and absence is recorded as absence."
        ),
    ]


class PersonProfiledPayload(WireModel, frozen=True):
    """
    Payload for person:profiled — what the knowledge base's issuer said this subject is called, recorded once per change (system-level, no resourceId). The event's `userId` is the person's DID; this payload is the fact about it. Provenance never reads it: every artifact joins on the DID alone, and this is projected into people.json for readers to resolve against. Two lines for one DID mean the name changed, and the timestamps say when — which is why no artifact ever had to freeze a copy.
    """

    name: Annotated[
        str,
        Field(description="The display name as of this event, from the issuer's verified `name` claim."),
    ]


class JobStatusRequest(WireModel, frozen=True):
    """
    Request to check the status of a job
    """

    job_id: Annotated[JobId, Field(alias="jobId")]


class JobTagAnnotationResult(WireModel, frozen=True):
    """
    Result of a completed tag-annotation job.
    """

    kind: Annotated[
        Literal["tag-annotation"],
        Field(
            description="Discriminant — every JobResult member carries `kind`, single-valued, so a consumer holding only the result can tell what it is."
        ),
    ]
    tags_found: Annotated[int, Field(alias="tagsFound")]
    tags_created: Annotated[int, Field(alias="tagsCreated")]
    by_category: Annotated[
        dict[str, int],
        Field(alias="byCategory", description="Count of tags created per category"),
    ]


type JobType = Annotated[
    Literal[
        "reference-annotation",
        "generation",
        "highlight-annotation",
        "assessment-annotation",
        "comment-annotation",
        "tag-annotation",
    ],
    Field(description="Type of background job"),
]


class KbDescription(WireModel, frozen=True):
    """
    What a knowledge base says about itself, answered by the Archivist from the committed .semiont/config and the working tree it holds. The only source clients use for a knowledge base's name and domain.
    """

    name: Annotated[
        str,
        Field(description="The committed [project] name, or the knowledge base directory's name when none is declared."),
    ]
    domain: Annotated[
        str,
        Field(
            description="The committed [site] domain: the knowledge base's permanent identity. Its did is 'did:web:' + this domain (kbDid in @semiont/core). It names WHICH knowledge base this is, not which running copy: a local clone and a codespace of one repo report the same domain, so use it to verify what you connected to, never to select among copies. A knowledge base that declares none is refused with browse:kb-failed."
        ),
    ]
    git_branch: Annotated[
        str | None,
        Field(
            alias="gitBranch",
            description="The working tree's current git branch. Absent when the knowledge base does not sync git (`[git] sync` in its committed config), and when its tree is not a git checkout.",
        ),
    ] = None


class Edge(WireModel, frozen=True):
    source: str
    target: str
    type: Annotated[
        str,
        Field(
            description="Edge kind: `annotation-of` (an annotation → the resource it lives on), `cites` (a citing linking annotation → the focal resource), or a peer connection's own relationshipType (free-form; `link` when unnamed)"
        ),
    ]
    bidirectional: Annotated[bool | None, Field(description="Whether the connection goes both ways")] = None
    metadata: dict[str, JsonValue] | None = None


class MarkArchiveCommand(WireModel, frozen=True):
    """
    Bus command to archive a resource and optionally remove its file.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    storage_uri: Annotated[
        str | None,
        Field(
            alias="storageUri",
            description="Optional: where the resource's bytes live, so the archive can act on the file. An instruction to this handler, not a copy of the stored fact (that lives on the primary Representation). Working-tree URI, only file:// is supported.",
        ),
    ] = None
    keep_file: Annotated[bool | None, Field(alias="keepFile")] = None


class Options1(WireModel, frozen=True):
    instructions: str | None = None
    tone: (
        Literal[
            "scholarly",
            "explanatory",
            "conversational",
            "technical",
            "analytical",
            "critical",
            "balanced",
            "constructive",
        ]
        | None
    ) = None
    density: float | None = None
    language: str | None = None
    entity_types: Annotated[list[str] | None, Field(alias="entityTypes")] = None
    include_descriptive_references: Annotated[bool | None, Field(alias="includeDescriptiveReferences")] = None
    schema_id: Annotated[str | None, Field(alias="schemaId")] = None
    categories: list[str] | None = None


class Response4(WireModel, frozen=True):
    """
    The created annotation's identity.
    """

    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]


class MarkCreateOk(WireModel, frozen=True):
    """
    Success reply after creating an annotation, matched to the originating command by correlationId.
    """

    response: Annotated[Response4, Field(description="The created annotation's identity.")]


class Response5(WireModel, frozen=True):
    """
    What the commit persisted.
    """

    persisted: Annotated[
        int,
        Field(
            description="Annotations the command named that are durable in the event log. Equals the batch size on success, on a first commit and on a retry alike — the commit appends only what the resource does not already hold, so a wholly-redundant retry has still succeeded and says so. Not an append tally: a caller must never have to read a 0 as 'all good'."
        ),
    ]
    annotation_ids: Annotated[
        list[AnnotationId],
        Field(
            alias="annotationIds",
            description="Ids the batch covers, whether appended now or already present.",
        ),
    ]


class MarkCommitOk(WireModel, frozen=True):
    """
    Durability acknowledgement for a mark:commit batch: every annotation named by the command is in the event log at the moment this is emitted.
    """

    response: Annotated[Response5, Field(description="What the commit persisted.")]


class MarkDeleteCommand(WireModel, frozen=True):
    """
    Bus command to delete an annotation.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]
    resource_id: Annotated[ResourceId | None, Field(alias="resourceId")] = None


class Response6(WireModel, frozen=True):
    """
    The deleted annotation's identity.
    """

    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]


class MarkDeleteOk(WireModel, frozen=True):
    """
    Success reply after deleting an annotation, matched to the originating command by correlationId.
    """

    response: Annotated[Response6, Field(description="The deleted annotation's identity.")]


class MarkUnarchiveCommand(WireModel, frozen=True):
    """
    Bus command to unarchive a previously archived resource.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    storage_uri: Annotated[
        str | None,
        Field(
            alias="storageUri",
            description="Optional: where the resource's bytes are expected to be. When present the handler VERIFIES the file exists and fails loudly if it does not, rather than succeeding as a no-op. An instruction, not a copy of the stored fact (that lives on the primary Representation). Working-tree URI, only file:// is supported.",
        ),
    ] = None


class MarkUpdateEntityTypesCommand(WireModel, frozen=True):
    """
    Bus command to replace the entity types on a resource.
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    current_entity_types: Annotated[list[str], Field(alias="currentEntityTypes")]
    updated_entity_types: Annotated[list[str], Field(alias="updatedEntityTypes")]


class MatchSearchFailed(WireModel, frozen=True):
    """
    Error payload emitted on match:search-failed SSE channel.
    """

    reference_id: Annotated[AnnotationId, Field(alias="referenceId")]
    error: str


class MatchResourcesRequest(WireModel, frozen=True):
    """
    Request to search the knowledge base's resources by text. The Librarian answers: it matches the text lexically, and when nothing matches, by meaning.
    """

    search: Annotated[str, Field(description="The text to search for.")]
    archived: bool | None = None
    entity_type: Annotated[str | None, Field(alias="entityType")] = None
    offset: int | None = None
    limit: int | None = None


class MediaTokenRequest(WireModel, frozen=True):
    resource_id: Annotated[
        ResourceId,
        Field(
            alias="resourceId",
            description="The resource ID to generate a media token for",
        ),
    ]


class MediaTokenResponse(WireModel, frozen=True):
    token: Annotated[
        str,
        Field(description="Short-lived media token for use as ?token= query parameter on resource URLs"),
    ]


type Motivation = Annotated[
    Literal["assessing", "commenting", "highlighting", "linking", "tagging"],
    Field(description="Semiont-supported W3C Web Annotation motivations - https://www.w3.org/TR/annotation-vocab/#motivation"),
]


class ProtectedResourceMetadata(WireModel, frozen=True, extra="forbid"):
    """
    OAuth 2.0 Protected Resource Metadata (RFC 9728): which authorization server this knowledge base trusts, served at /.well-known/oauth-protected-resource so a client — the Browser, an MCP client — learns where to send a user to sign in without configuration. A 401 from any protected route points here in its WWW-Authenticate challenge.
    """

    resource: Annotated[
        str,
        Field(
            description="This knowledge base's resource identifier: its did:web identity resolved to an https URL (did:web:example.github.io:my-kb identifies https://example.github.io/my-kb). This is the exact value a token's aud claim must carry. It is an identifier, not an address — nothing dereferences it, and a knowledge base reached over http in local development still names itself by the https form, which is what makes the value stable across every host, port and proxy it is reached through."
        ),
    ]
    authorization_servers: Annotated[
        list[str],
        Field(description="Issuer identifiers whose tokens this resource accepts — the configured identity issuer."),
    ]
    bearer_methods_supported: Annotated[
        list[Literal["header"]],
        Field(description="How a bearer token reaches this resource: the Authorization header only."),
    ]
    resource_name: Annotated[
        str | None,
        Field(description="The knowledge base's name, for a client's sign-in prompt."),
    ] = None


type Type = Annotated[list[str], Field(description="Type(s), e.g., schema:MediaObject.", min_length=1)]


class Representation(WireModel, frozen=True, extra="allow"):
    """
    A specific, byte-addressable rendition of a resource (file/asset/variant).
    """

    id: Annotated[str | None, Field(alias="@id", description="Stable ID for this representation.")] = None
    type: Annotated[
        str | Type | None,
        Field(alias="@type", description="Type(s), e.g., schema:MediaObject."),
    ] = None
    media_type: Annotated[
        str,
        Field(
            alias="mediaType",
            description="MIME/media type (e.g., text/markdown, image/png).",
        ),
    ]
    storage_uri: Annotated[
        str | None,
        Field(
            alias="storageUri",
            description="Working-tree URI identifying where this rendition's bytes live. Only file:// is supported (e.g. file://docs/overview.md). The single home of the storage location: maintained across moves (yield:moved relocates it), absent when the resource has no stored bytes.",
        ),
    ] = None
    filename: str | None = None
    byte_size: Annotated[
        int | None,
        Field(alias="byteSize", description="Size of the payload in bytes.", ge=0),
    ] = None
    checksum: Annotated[str | None, Field(description="Integrity hash (e.g., sha256:abcd…).")] = None
    encoding: Annotated[str | None, Field(description="Compression/transfer encoding if applicable.")] = None
    language: Annotated[str | None, Field(description="IETF BCP 47 language tag (e.g., en, es-ES).")] = None
    width: Annotated[int | None, Field(description="Pixels (images/video).", ge=0)] = None
    height: Annotated[int | None, Field(description="Pixels (images/video).", ge=0)] = None
    duration: Annotated[float | None, Field(description="Seconds (audio/video).", ge=0.0)] = None
    created: str | None = None
    modified: str | None = None
    conforms_to: Annotated[
        str | list[str] | None,
        Field(
            alias="conformsTo",
            description="Profile/shape the bytes conform to (e.g., a JSON profile or SVG profile).",
        ),
    ] = None
    tags: list[str] | None = None
    rel: Annotated[
        Literal["original", "thumbnail", "preview", "optimized", "derived", "other"] | None,
        Field(description="Semantics of this rendition relative to the resource (e.g., original, thumbnail, preview, derived)."),
    ] = None


class RepresentationAddedPayload(WireModel, frozen=True):
    """
    Payload for yield:representation-added domain event
    """

    representation: Representation


class RepresentationRemovedPayload(WireModel, frozen=True):
    """
    Payload for yield:representation-removed domain event
    """

    checksum: Annotated[str, Field(description="Checksum of the representation to remove")]


class ResourceArchivedPayload(WireModel, frozen=True):
    """
    Payload for mark:archived domain event
    """

    reason: str | None = None


class GeneratedFrom(WireModel, frozen=True):
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]


type Type1 = Annotated[
    list[str],
    Field(description="Type(s) of the resource (IRIs/CURIEs via @context).", min_length=1),
]


type Identifier = Annotated[
    list[str],
    Field(description="Persistent identifiers (e.g., DOI, URN).", min_length=1),
]


class Identifier1(WireModel, frozen=True, extra="allow"):
    """
    Persistent identifiers (e.g., DOI, URN).
    """

    id: Annotated[str | None, Field(alias="@id")] = None
    value: str | None = None
    scheme: str | None = None


type About = Annotated[list[str], Field(description="Topics (IRIs or strings).", min_length=1)]


class ResourceMovedPayload(WireModel, frozen=True):
    """
    Payload for yield:moved domain event
    """

    from_uri: Annotated[str, Field(alias="fromUri", description="Previous file:// URI")]
    to_uri: Annotated[str, Field(alias="toUri", description="New file:// URI")]


class ResourceUnarchivedPayload(WireModel, frozen=True):
    """
    Payload for mark:unarchived domain event (empty payload)
    """


class ResourceUpdatedPayload(WireModel, frozen=True):
    """
    Payload for yield:updated domain event
    """

    content_checksum: Annotated[str, Field(alias="contentChecksum", description="SHA-256 of new content")]
    content_byte_size: Annotated[int | None, Field(alias="contentByteSize")] = None


class SelectionData(WireModel, frozen=True):
    """
    Selection data for user-initiated annotations. Captures the text range and optional selector information from a user's highlight in the UI.
    """

    exact: Annotated[str, Field(description="The exact selected text")]
    start: Annotated[int, Field(description="Start character offset")]
    end: Annotated[int, Field(description="End character offset")]
    svg_selector: Annotated[
        str | None,
        Field(
            alias="svgSelector",
            description="SVG selector for non-text selections (e.g. PDF regions)",
        ),
    ] = None
    fragment_selector: Annotated[
        str | None,
        Field(alias="fragmentSelector", description="Fragment selector (e.g. page=2)"),
    ] = None
    conforms_to: Annotated[
        str | None,
        Field(
            alias="conformsTo",
            description="Specification the fragment selector conforms to",
        ),
    ] = None
    prefix: Annotated[str | None, Field(description="Text before the selection (for disambiguation)")] = None
    suffix: Annotated[str | None, Field(description="Text after the selection (for disambiguation)")] = None


class SemanticMatch(WireModel, frozen=True):
    text: Annotated[str, Field(description="The chunk text that matched")]
    resource_id: Annotated[ResourceId, Field(alias="resourceId", description="Source resource ID")]
    resource_name: Annotated[
        str,
        Field(
            alias="resourceName",
            description="The source resource's display name, resolved from its view at gather time. Required: a match card must name its source, and corpus matches routinely come from outside the graph neighborhood, so there is no node to borrow a name from. A match whose source no longer resolves to a view is dropped by the producer rather than served nameless.",
        ),
    ]
    annotation_id: Annotated[
        AnnotationId | None,
        Field(
            alias="annotationId",
            description="Source annotation ID, if the match is from an annotation",
        ),
    ] = None
    score: Annotated[float, Field(description="Cosine similarity score (0-1)")]
    entity_types: Annotated[
        list[str] | None,
        Field(alias="entityTypes", description="Entity types on the matched passage"),
    ] = None
    machine_read: Annotated[
        bool | None,
        Field(
            alias="machineRead",
            description="True when this passage's text was recognized from pixels (OCR of a scanned page) rather than read from the document. Absent means read directly — the common case — so the flag is only present where it changes how the text should be trusted. It travels with the passage because a consumer receives the chunk with no document attached and cannot recompute how the text was obtained.",
        ),
    ] = None


class SessionJoinedEvent(WireModel, frozen=True):
    """
    A participant opened a live connection to this KB — an SSE stream on /bus/subscribe. Presence is CONNECTION lifecycle, not login: a token can be minted and sit unused, so what this reports is that someone is WATCHING. One person with two tabs produces two of these, which is why connectionId is required — the DID alone cannot tell two connections apart, and a consumer that counts DIDs will undercount viewers.
    """

    participant: Annotated[
        UserId,
        Field(
            description="DID of the authenticated principal on that connection. A person or a software agent — the bus does not distinguish."
        ),
    ]
    connection_id: Annotated[
        str,
        Field(
            alias="connectionId",
            description="Identifies this connection for its lifetime. The matching session:left carries the same value.",
        ),
    ]


class SessionLeftEvent(WireModel, frozen=True):
    """
    A participant's live connection to this KB ended — the SSE stream aborted. Carries the same connectionId as the session:joined that opened it, so a consumer tracking who is present can retire the right connection rather than assuming one per participant.
    """

    participant: Annotated[
        UserId,
        Field(description="DID of the authenticated principal on that connection."),
    ]
    connection_id: Annotated[
        str,
        Field(
            alias="connectionId",
            description="The connectionId announced by the matching session:joined.",
        ),
    ]


class SettingsHoverDelayChangedEvent(WireModel, frozen=True):
    """
    Emitted when the hover delay setting changes
    """

    hover_delay_ms: Annotated[int, Field(alias="hoverDelayMs")]


class SettingsLocaleChangedEvent(WireModel, frozen=True):
    """
    Emitted when the UI locale setting changes
    """

    locale: str


class SettingsThemeChangedEvent(WireModel, frozen=True):
    """
    Emitted when the UI theme setting changes
    """

    theme: Literal["light", "dark", "system"]


class SpecificResource(WireModel, frozen=True):
    type: Literal["SpecificResource"]
    source: Annotated[ResourceId, Field(description="The id of the resource this body leads to")]
    purpose: Annotated[BodyPurpose | None, Field(description="Why this body is included")] = None


class Features(WireModel, frozen=True):
    semantic_content: Annotated[str, Field(alias="semanticContent")]
    collaboration: str


class StatusResponse(WireModel, frozen=True):
    status: str
    version: str
    features: Features
    message: str
    authenticated_as: Annotated[str | None, Field(alias="authenticatedAs")] = None


class StoredEventResponse(WireModel, frozen=True):
    """
    A persisted domain event with metadata. Flat shape — event fields and metadata are peers.
    """

    id: Annotated[str, Field(description="Unique event ID (UUID)")]
    type: Annotated[str, Field(description="Event type (flow verb name, e.g. mark:added)")]
    timestamp: Annotated[str, Field(description="When the event occurred")]
    user_id: Annotated[
        UserId,
        Field(alias="userId", description="DID of the user who triggered the event"),
    ]
    resource_id: Annotated[
        ResourceId | None,
        Field(
            alias="resourceId",
            description="Resource this event affects (absent for system events)",
        ),
    ] = None
    version: Annotated[int, Field(description="Event schema version")]
    payload: Annotated[dict[str, JsonValue], Field(description="Event-type-specific payload")]
    metadata: EventMetadata


type SupportedMediaType = Annotated[
    Literal[
        "text/plain",
        "text/markdown",
        "text/html",
        "text/css",
        "text/csv",
        "text/xml",
        "application/json",
        "application/xml",
        "application/yaml",
        "application/x-yaml",
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/zip",
        "application/gzip",
        "application/x-tar",
        "application/x-7z-compressed",
        "application/octet-stream",
        "application/wasm",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/svg+xml",
        "image/bmp",
        "image/tiff",
        "image/x-icon",
        "video/mp4",
        "video/mpeg",
        "video/webm",
        "video/ogg",
        "video/quicktime",
        "video/x-msvideo",
        "audio/mpeg",
        "audio/wav",
        "audio/ogg",
        "audio/webm",
        "audio/aac",
        "audio/flac",
        "text/javascript",
        "application/javascript",
        "text/x-typescript",
        "application/typescript",
        "text/x-python",
        "text/x-java",
        "text/x-c",
        "text/x-c++",
        "text/x-csharp",
        "text/x-go",
        "text/x-rust",
        "text/x-ruby",
        "text/x-php",
        "text/x-swift",
        "text/x-kotlin",
        "text/x-shell",
        "font/woff",
        "font/woff2",
        "font/ttf",
        "font/otf",
    ],
    Field(
        description="Base MIME types (no parameters) admitted by Semiont. Membership is the create/yield gate — every member is storable, nameable, and uploadable. What more the system can do with a type (render, annotate, extract text, author) is curated per type in @semiont/core's media-type registry, which is keyed by this enum."
    ),
]


class SvgSelector(WireModel, frozen=True):
    type: Literal["SvgSelector"]
    value: Annotated[
        str,
        Field(description="SVG markup defining the region (must include xmlns attribute)"),
    ]


class TagCategory(WireModel, frozen=True):
    """
    A single category within a tag schema (e.g. 'Issue' in IRAC, 'distinguished' in legal-citation-treatment). Each category carries methodology-bound semantics: a name, a description, and examples used in the LLM prompt.
    """

    name: str
    description: str
    examples: list[str]


class TagSchema(WireModel, frozen=True):
    """
    A structural-analysis schema (e.g. legal-irac, scientific-imrad, argument-toulmin). Defines a methodology framework as an id, name, description, domain hint, and an ordered list of categories. KBs and their skills register schemas with the runtime registry via `frame.addTagSchema(...)` at session start.
    """

    id: str
    name: str
    description: str
    domain: Annotated[
        str,
        Field(
            description="Free-form domain hint (e.g. 'legal', 'scientific', 'general'). Used in the LLM prompt to tune the model's analysis voice. KB authors choose."
        ),
    ]
    tags: list[TagCategory]


class TagSchemaAddedPayload(WireModel, frozen=True):
    """
    Payload for frame:tag-schema-added domain event (system-level, no resourceId — fan-out is global to the KB).
    """

    schema_: Annotated[TagSchema, Field(alias="schema")]


class TextPositionSelector(WireModel, frozen=True):
    type: Literal["TextPositionSelector"]
    start: Annotated[float, Field(description="Character offset from resource start")]
    end: Annotated[float, Field(description="Character offset from resource start")]


class TextQuoteSelector(WireModel, frozen=True):
    type: Literal["TextQuoteSelector"]
    exact: str
    prefix: str | None = None
    suffix: str | None = None


class TextualBody(WireModel, frozen=True):
    type: Literal["TextualBody"]
    value: Annotated[str, Field(description="The text content (e.g., entity type name)")]
    purpose: Annotated[BodyPurpose | None, Field(description="Why this body is included")] = None
    format: Annotated[str | None, Field(description="MIME type (defaults to text/plain)")] = None
    language: Annotated[str | None, Field(description="BCP 47 language tag")] = None


class UserResponse(WireModel, frozen=True):
    """
    The authenticated principal, as this knowledge base names it.

    The `did` is the identity: it is what the bus stamps on every event, what resource creation is attributed to, and what a client must compare against to recognise its own work in the data. It is the only identifier: a row id would appear nowhere else in the system and correlate with nothing.

    The remaining fields exist to be displayed, and all of them come from the token's own claims.
    """

    did: Annotated[
        UserId,
        Field(
            description="The authenticated principal's DID — `did:web:<domain>:users:<subject>` for a person, where the subject is the issuer claim the knowledge base names its people by (`identity.subjectClaim`), `did:web:<domain>:agents:<provider>:<model>` for a software agent."
        ),
    ]
    email: str
    name: Annotated[str | None, Field(...)]
    image: Annotated[str | None, Field(...)]
    domain: Annotated[
        str,
        Field(
            description="Not always the email's suffix: a software agent's email sits in an `agents.<host>` namespace while its domain is the deployment's."
        ),
    ]


class SmeltRebuildAnchorsCommand(WireModel, frozen=True):
    """
    Bus command to rebuild anchored-text artifacts by re-running extraction — every geometry-capable resource when resourceId is absent, one resource when present. Served by the Smelter, serialized (each unit can be a multi-second OCR pass), and never destructive: nothing is deleted first, stale entries are simply overwritten. Re-anchoring makes zero embedding calls — the vectors are already correct; only the derived map is re-made. Partial completion replies failed, with counts: a rebuild that quietly skipped resources would present exactly like a document with no text.
    """

    resource_id: Annotated[
        ResourceId | None,
        Field(
            alias="resourceId",
            description="When present, re-anchor only this resource; otherwise every geometry-capable resource in the catalog.",
        ),
    ] = None
    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None


class WeaveRebuildCommand(WireModel, frozen=True):
    """
    Bus command to rebuild the graph projection from the event log — the whole graph when resourceId is absent, one resource when present. Served by the Weaver; replaces direct rebuild access, which does not survive the Weaver's container split.
    """

    resource_id: Annotated[
        ResourceId | None,
        Field(
            alias="resourceId",
            description="When present, rebuild only this resource; otherwise clear and rebuild the entire graph.",
        ),
    ] = None
    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None


class YieldCloneCreateCommand(WireModel, frozen=True):
    """
    Bus command to create a cloned resource from a clone token. Bytes are stored by the upload path BEFORE this command is emitted, because bytes travel over HTTP and never over the bus — the command carries the storage coordinates, never content.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    token: str
    name: str
    storage_uri: Annotated[
        str,
        Field(
            alias="storageUri",
            description="Where the caller already wrote the clone's bytes — an instruction, not a copy of the stored fact (that lives on the primary Representation). Bytes are stored through the byte door BEFORE this command is sent, so this names an existing file. Working-tree URI, only file:// is supported.",
        ),
    ]
    content_checksum: Annotated[str, Field(alias="contentChecksum")]
    byte_size: Annotated[int, Field(alias="byteSize")]
    format: ContentFormat
    archive_original: Annotated[bool | None, Field(alias="archiveOriginal")] = None


class Response7(WireModel, frozen=True):
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class YieldCloneCreated(WireModel, frozen=True):
    """
    Success response after creating a cloned resource.
    """

    response: Response7


class YieldCloneResourceRequest(WireModel, frozen=True):
    """
    Bus command to request cloning a resource using a clone token.
    """

    token: str


class YieldCloneTokenRequest(WireModel, frozen=True):
    """
    Bus command to request a clone token for a resource.
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class GeneratedFrom1(WireModel, frozen=True):
    resource_id: Annotated[ResourceId | None, Field(alias="resourceId")] = None
    annotation_id: Annotated[AnnotationId | None, Field(alias="annotationId")] = None


class YieldClonePersistCommand(WireModel, frozen=True):
    """
    Command: stow an already-uploaded clone's bytes and append `yield:cloned`.

    The INNER half of the clone flow. `yield:clone-create` reaches the CloneTokenManager, which alone can validate the token and read the source's entity types; it then emits this so the Stower — the only appendEvent caller — writes the domain event.

    Distinct from `yield:create` because a clone is a distinct operation, not a creation with an extra field. It REQUIRES a parent, and that requirement is what a separate command expresses: an optional `parentResourceId` on the create command could not say that a clone without a parent is not a clone. `ResourceClonedPayload` requires it for the same reason.

    Generated resources are NOT clones: they carry provenance in `generatedFrom` and stay on `yield:create`.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Injected by the gateway from the authenticated principal; never supplied by a wire caller.",
        ),
    ] = None
    name: str
    storage_uri: Annotated[
        str,
        Field(
            alias="storageUri",
            description="The caller's instruction for WHERE the bytes are — the uploader wrote them before emitting this. The stored location lives on the clone's primary Representation, the one home of a storage URI.",
        ),
    ]
    content_checksum: Annotated[str, Field(alias="contentChecksum")]
    byte_size: Annotated[int, Field(alias="byteSize")]
    format: ContentFormat
    language: str | None = None
    entity_types: Annotated[
        list[str] | None,
        Field(
            alias="entityTypes",
            description="Inherited from the source resource by the CloneTokenManager, which is the only party that knows the token is valid.",
        ),
    ] = None
    parent_resource_id: Annotated[
        ResourceId,
        Field(
            alias="parentResourceId",
            description="The resource this one is cloned FROM. Required: it is what makes this a clone rather than a creation.",
        ),
    ]


class Response8(WireModel, frozen=True):
    """
    The created resource's identity.
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class YieldCreateOk(WireModel, frozen=True):
    """
    Success reply after creating a yielded resource, matched to the originating command by correlationId.
    """

    response: Annotated[Response8, Field(description="The created resource's identity.")]


class Response9(WireModel, frozen=True):
    """
    The clone's identity — a new resource, distinct from its parent.
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class YieldClonePersistOk(WireModel, frozen=True):
    """
    Success reply after cloning a resource, matched to the originating command by correlationId.
    """

    response: Annotated[
        Response9,
        Field(description="The clone's identity — a new resource, distinct from its parent."),
    ]


class YieldMvCommand(WireModel, frozen=True):
    """
    Bus command to move (rename) a yielded resource.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    from_uri: Annotated[str, Field(alias="fromUri")]
    to_uri: Annotated[str, Field(alias="toUri")]


class YieldUpdateCommand(WireModel, frozen=True):
    """
    Bus command to update a yielded resource's storage content.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    storage_uri: Annotated[
        str,
        Field(
            alias="storageUri",
            description="The caller's instruction for WHERE the bytes are — not a copy of the stored fact. The stored location lives on the resource's primary Representation (`Representation.storageUri`), which is its single home; this field is the message that puts it there. Working-tree URI, only file:// is supported (e.g. file://docs/overview.md).",
        ),
    ]
    content_checksum: Annotated[str, Field(alias="contentChecksum")]
    byte_size: Annotated[int, Field(alias="byteSize")]


class Response10(WireModel, frozen=True):
    """
    The updated resource's identity.
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class YieldUpdateOk(WireModel, frozen=True):
    """
    Success reply after updating a yielded resource, matched to the originating command by correlationId.
    """

    response: Annotated[Response10, Field(description="The updated resource's identity.")]


class BusFrame(WireModel, frozen=True, extra="forbid"):
    """
    One frame of the bus stream, as the `data` line of a `bus-event` message carries it (JSON-serialised on one line). `payload` is the channel's payload as its registry entry declares it. A frame on a scoped subscription carries the scope it was published on; a correlated reply carries the `correlationId` of the request it answers.
    """

    channel: Annotated[
        str,
        Field(
            description="A channel of the bus registry (specs/src/bus/registry.json).",
            min_length=1,
        ),
    ]
    correlation_id: Annotated[
        str | None,
        Field(
            alias="correlationId",
            description="The request this frame answers. Present on correlated replies; absent otherwise.",
            min_length=1,
        ),
    ] = None
    payload: Annotated[
        dict[str, JsonValue],
        Field(
            description="The channel's payload. A replayed persisted event is the stored event itself, whose `metadata.sequenceNumber` the message id carries."
        ),
    ]
    scope: Annotated[
        ResourceId | None,
        Field(
            description="The resource scope the frame was published on. Present exactly when it arrived through a `scoped` entry of the subscription."
        ),
    ] = None


class BusPingMessage(WireModel, frozen=True, extra="forbid"):
    """
    The heartbeat: `event: ping` with an empty `data:` line. The first is written once the stream has caught up (after any replay), then one every `x-semiont-limits.heartbeatSeconds`. It carries no id, so it never disturbs a client's last-seen ids.
    """

    event: Literal["ping"]
    data: Annotated[str, Field(max_length=0)]


class BusResumeGap(WireModel, frozen=True, extra="forbid"):
    """
    The payload of `bus:resume-gap`: a scope's `lastEventId` could not be honoured, so the client cannot trust that it has every persisted event of that scope and must refetch what it caches for it. Written by the gateway, never by a participant.
    """

    scope: Annotated[
        ResourceId,
        Field(description="The scope of the subscription entry whose watermark failed."),
    ]
    last_seen_id: Annotated[str, Field(alias="lastSeenId", description="The watermark the entry carried.")]
    reason: Annotated[
        Literal[
            "unparseable-last-event-id",
            "scope-mismatch",
            "retention-exceeded",
            "query-error",
        ],
        Field(
            description="`unparseable-last-event-id`: the watermark is not a PersistedEventId. `scope-mismatch`: it names another scope. `retention-exceeded`: the record no longer holds the events after it (what it still holds is replayed first). `query-error`: the record could not be read."
        ),
    ]


type EphemeralEventId = Annotated[
    str,
    Field(
        description="`e-<publishId>` — the id of any other frame, given once when the frame is published: the same on every connection that carries it, through every replica, so a copy arriving on two connections (a reconnect overlap) dedups. Never a resumption watermark.",
        pattern="^e-[^:]+$",
    ),
]


type PersistedEventId = Annotated[
    str,
    Field(
        description="`p-<scope>-<sequenceNumber>` — the id of a persisted event delivered on a scoped subscription. Resumable: send it back as that scope's `lastEventId`. Stable across connections, so a client dedups by it.",
        pattern="^p-.+-[0-9]+$",
    ),
]


type ReplyEventId = Annotated[
    str,
    Field(
        description="`e-<channel>:<correlationId>` — the id of a frame that carries a correlationId. Deterministic: the same reply has the same id on every connection, so a copy arriving on two connections (a reconnect overlap, or a replay of a retained reply) dedups. Never a resumption watermark.",
        pattern="^e-[^:]+:[^:]+:.+$",
    ),
]


class AgentTokenRequest(WireModel, frozen=True):
    """
    The (provider, model) the agent token is issued for: together they name the agent.
    """

    provider: Annotated[
        str,
        Field(description="Inference provider (e.g. ollama, anthropic)", min_length=1),
    ]
    model: Annotated[
        str,
        Field(
            description="Model identifier (e.g. gemma2:27b, claude-3-5-sonnet)",
            min_length=1,
        ),
    ]


class AgentTokenResponse(WireModel, frozen=True):
    """
    The agent token and the DID it names.
    """

    token: Annotated[str, Field(description="Bearer JWT for subsequent authenticated requests")]
    did: Annotated[
        UserId,
        Field(description="DID of the software-agent identity the token is acting as"),
    ]


class Kb(WireModel, frozen=True, extra="forbid"):
    """
    The knowledge base's committed identity (`[project] name` and `[site] domain` in its .semiont/config).
    """

    name: Annotated[
        str,
        Field(
            description="Its name, published as the resource metadata's `resource_name`.",
            min_length=1,
        ),
    ]
    domain: Annotated[
        str,
        Field(
            description="Its did:web domain: its permanent identity, the source of the audience its tokens must carry, and the authority its people and agents are named under.",
            min_length=1,
        ),
    ]


class Identity(WireModel, frozen=True, extra="forbid"):
    """
    The issuer this knowledge base trusts.
    """

    issuer: Annotated[
        str,
        Field(
            description="The issuer URL, exactly as tokens carry it in `iss`.",
            min_length=1,
        ),
    ]
    subject_claim: Annotated[
        str,
        Field(
            alias="subjectClaim",
            description="The claim a person's DID is built from: `did:web:<domain>:users:<its value>`.",
            min_length=1,
        ),
    ]


class Archivist(WireModel, frozen=True, extra="forbid"):
    """
    Where the Archivist listens.
    """

    host: Annotated[str, Field(min_length=1)]
    port: Annotated[int, Field(ge=1, le=65535)]


class Signal(WireModel, frozen=True, extra="forbid"):
    """
    The signal plane: `in-process`, one gateway on its own fabric; or `nats`, the fabric every replica on one broker shares, which requires `servers` and a broker with JetStream.
    """

    type: Literal["in-process", "nats"]
    servers: Annotated[
        str | None,
        Field(
            description="The broker's address (`host:port`, or several, comma-separated). Required for `nats`.",
            min_length=1,
        ),
    ] = None
    user_env: Annotated[
        str | None,
        Field(
            alias="userEnv",
            description="The environment variable holding the broker user, when the broker requires one.",
            min_length=1,
        ),
    ] = None
    password_env: Annotated[
        str | None,
        Field(
            alias="passwordEnv",
            description="The environment variable holding the broker password, when the broker requires one.",
            min_length=1,
        ),
    ] = None


class Capacity(WireModel, frozen=True, extra="forbid"):
    """
    What this gateway process can hold, from the memory its deployment gives it. `queuedBytes`: the bytes queued for all its streams together; at it, a new stream is refused with 503 (`AtCapacity`, code `capacity`) until the queues drain — each stream's own bound is `x-semiont-limits.pendingWriteBytes`. `connections`: the connections it holds open at once; one past it is closed unanswered. The launcher derives both from the memory it gives the gateway's container.
    """

    queued_bytes: Annotated[int, Field(alias="queuedBytes", ge=1)]
    connections: Annotated[int, Field(ge=1)]


class ResourceUpload(WireModel, frozen=True):
    """
    The multipart upload that creates a resource. A client sends it to the gateway's `POST /resources`; the gateway forwards it untouched to the Archivist's `POST /resources`, which stores the bytes and records the resource. One body, two hops.
    """

    name: Annotated[str, Field(description="Human-readable resource name")]
    file: Annotated[bytes, Field(description="Binary content")]
    format: Annotated[
        str,
        Field(description="Media type of the content (e.g. text/plain, text/markdown, image/png)"),
    ]
    storage_uri: Annotated[
        str,
        Field(
            alias="storageUri",
            description="Where the content lives (file://... for local). Required — the client names the location; the server does not derive one.",
        ),
    ]
    language: Annotated[str | None, Field(description="ISO 639-1 language code")] = None
    entity_types: Annotated[
        str | None,
        Field(
            alias="entityTypes",
            description="JSON-stringified array of entity type names",
        ),
    ] = None
    source_annotation_id: Annotated[
        AnnotationId | None,
        Field(
            alias="sourceAnnotationId",
            description="For AI-generated resources: the annotation that triggered generation. Nested into generatedFrom.annotationId on the persisted event.",
        ),
    ] = None
    source_resource_id: Annotated[
        ResourceId | None,
        Field(
            alias="sourceResourceId",
            description="For AI-generated resources: the source resource the generating annotation lives on. Nested into generatedFrom.resourceId on the persisted event.",
        ),
    ] = None
    generation_prompt: Annotated[
        str | None,
        Field(
            alias="generationPrompt",
            description="For AI-generated resources: the prompt that drove generation",
        ),
    ] = None
    generator: Annotated[
        str | None,
        Field(
            description="For AI-generated resources: JSON-stringified Agent naming the model/worker that produced the content. Its identity must be the uploading agent's own — the knowledge base refuses a generator naming anyone else. `creator` and `wasAttributedTo` are never sent; the knowledge base derives them from the cited job."
        ),
    ] = None
    job_id: Annotated[
        JobId | None,
        Field(
            alias="jobId",
            description="The job this resource fulfils, when a worker is creating it. Forwarded onto yield:create; the knowledge base derives who requested the resource from the cited job's own events, and refuses a worker-role create that cites none. Absent for a person's own upload.",
        ),
    ] = None
    is_draft: Annotated[
        str | None,
        Field(
            alias="isDraft",
            description="'true' or 'false' — whether the resource is a draft",
        ),
    ] = None
    clone_token: Annotated[
        str | None,
        Field(
            alias="cloneToken",
            description="A clone token from `yield:clone-token-requested`. With it, the resource is created as a clone of the token's source, inheriting its entity types; `language`, `entityTypes` and the generation fields are then not read.",
        ),
    ] = None
    archive_original: Annotated[
        str | None,
        Field(
            alias="archiveOriginal",
            description="With `cloneToken`: 'true' archives the source once the clone exists.",
        ),
    ] = None


class ArchivistEventsResponse(WireModel, frozen=True):
    """
    The events of one resource from one sequence number, inclusive, in log order: the Archivist's answer to `GET /events/{resourceId}`, which the gateway reads to replay a scope a subscriber resumes.
    """

    events: list[StoredEventResponse]


class ArchivistHealth(WireModel, frozen=True):
    """
    The Archivist's liveness answer: it serves, and the actors it hosts.
    """

    status: Literal["ok"]
    actors: Annotated[list[str], Field(description="The record actors this process hosts.")]


class RepresentationNotFound(WireModel, frozen=True):
    """
    The Archivist's 404 for a resource's bytes: an ErrorResponse whose `code` says which half of the lookup failed — `resource` when the record holds no such resource, `representation` when it holds the resource but not its bytes. Each reader answers the two differently.
    """

    error: Annotated[str, Field(description="What went wrong, in a sentence.")]
    code: Literal["resource", "representation"]
    hint: Annotated[
        str | None,
        Field(description="What the caller can do about it, when there is something to say."),
    ] = None
    details: JsonValue | None = None


class LimitRefusal(WireModel, frozen=True):
    """
    An ErrorResponse that names, in `code`, the limit the request met.
    """

    error: Annotated[str, Field(description="What went wrong, in a sentence.")]
    code: Annotated[
        Literal["streams", "emit-rate", "unanswered-requests", "capacity"],
        Field(
            description="`streams`: the principal already holds as many streams as its coefficient of `x-semiont-limits.streamsPerPrincipal` allows. `emit-rate`: the principal's emits have used its bucket, whose rate and burst are its coefficient of `x-semiont-limits.emitsPerPrincipal`, per gateway process. `unanswered-requests`: the client already awaits as many replies as `BusSubscribeRequest.pendingReplies` may name. `capacity`: the gateway holds as many queued bytes as it can."
        ),
    ]
    hint: Annotated[
        str | None,
        Field(description="What the caller can do about it, when there is something to say."),
    ] = None
    details: JsonValue | None = None


class JobMetadata(WireModel, frozen=True, extra="forbid"):
    """
    What the dispatcher records about a job beside its parameters. `completedUnits` and `unitCursors` appear once a worker has checkpointed. `retryCount` counts the times the queue has put the job back to pending after a failure it classes as transient.
    """

    id: Annotated[
        JobId,
        Field(description="The job's id: `job-` followed by a version 4 UUID written as 32 lowercase hex digits, without dashes."),
    ]
    type: JobType
    user_id: Annotated[
        UserId,
        Field(
            alias="userId",
            description="The DID of the principal whose `job:create` created the job.",
        ),
    ]
    created: Annotated[str, Field(description="When the job was created, as an ISO 8601 timestamp.")]
    retry_count: Annotated[int, Field(alias="retryCount", ge=0)]
    max_retries: Annotated[
        int,
        Field(
            alias="maxRetries",
            description="How many transient failures the queue retries: 0 for generation, whose re-run produces different content; 1 for every other type.",
            ge=0,
        ),
    ]
    completed_units: Annotated[
        list[str] | None,
        Field(
            alias="completedUnits",
            description="The units a worker has finished, merged across checkpoints and failures as a set.",
        ),
    ] = None
    unit_cursors: Annotated[
        dict[str, UnitCursor] | None,
        Field(
            alias="unitCursors",
            description="How far each unfinished unit got, keyed by unit.",
        ),
    ] = None


class JobParams(WireModel, frozen=True, extra="allow"):
    """
    The parameters a job was created with: the `params` of its `job:create`, with the resource the job is about under `resourceId`. For generation the dispatcher derives that resource from the context's focus; for every other type it is the request's `resourceId`. The other fields depend on the job type and are carried as the caller sent them.
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class JobPending(WireModel, frozen=True, extra="forbid"):
    """
    A job waiting for a worker to claim it.
    """

    status: Literal["pending"]
    metadata: JobMetadata
    params: JobParams


class JobFailed(WireModel, frozen=True, extra="forbid"):
    """
    A job that failed and will not be retried.
    """

    status: Literal["failed"]
    metadata: JobMetadata
    params: JobParams
    started_at: Annotated[
        str | None,
        Field(
            alias="startedAt",
            description="When the last claim was made; absent when it failed without one.",
        ),
    ] = None
    completed_at: Annotated[str, Field(alias="completedAt", description="When it failed.")]
    error: Annotated[str, Field(description="The failure's message.")]


class JobCancelled(WireModel, frozen=True, extra="forbid"):
    """
    A job cancelled before it concluded.
    """

    status: Literal["cancelled"]
    metadata: JobMetadata
    params: JobParams
    started_at: Annotated[
        str | None,
        Field(
            alias="startedAt",
            description="When its claim was made; absent when it was cancelled while pending.",
        ),
    ] = None
    completed_at: Annotated[str, Field(alias="completedAt", description="When it was cancelled.")]


type LogLevel = Annotated[
    Literal["error", "warn", "info", "http", "debug"],
    Field(description="How much a service logs: the least severe level it writes, from error, the most severe, to debug."),
]


type LogFormat = Annotated[
    Literal["json", "simple"],
    Field(
        description="How each log line is written to stdout: `json`, one JSON object per line carrying the active trace's `trace_id` and `span_id`; or `simple`, `<timestamp> [<LEVEL>] <message>` followed by any metadata as JSON."
    ),
]


class Identity1(WireModel, frozen=True, extra="forbid"):
    """
    The issuer the dispatcher's service account signs in at.
    """

    issuer: Annotated[
        str,
        Field(
            description="The issuer URL, exactly as tokens carry it in `iss`.",
            min_length=1,
        ),
    ]


class Queue(WireModel, frozen=True, extra="forbid"):
    """
    The JetStream broker holding the job queue, whose layout is specs/src/jobs/storage.json.
    """

    servers: Annotated[
        str,
        Field(
            description="The broker's address (`host:port`, or several, comma-separated).",
            min_length=1,
        ),
    ]
    user_env: Annotated[
        str | None,
        Field(
            alias="userEnv",
            description="The environment variable holding the broker user, when the broker requires one.",
            min_length=1,
        ),
    ] = None
    password_env: Annotated[
        str | None,
        Field(
            alias="passwordEnv",
            description="The environment variable holding the broker password, when the broker requires one.",
            min_length=1,
        ),
    ] = None


class Timing(WireModel, frozen=True, extra="forbid"):
    """
    The queue's clocks, in milliseconds. The launcher writes the values a deployment runs with; a test harness shrinks them.
    """

    tick_ms: Annotated[
        int,
        Field(
            alias="tickMs",
            description="How often the queue re-announces pending jobs and sweeps for dead workers. The re-announcement is insurance against a lost wake-up, not dispatch.",
            ge=1,
        ),
    ]
    stale_running_ms: Annotated[
        int,
        Field(
            alias="staleRunningMs",
            description="How long a running job may go without progress, a checkpoint or a claim before its worker is presumed dead.",
            ge=1,
        ),
    ]
    ack_wait_ms: Annotated[
        int,
        Field(
            alias="ackWaitMs",
            description="How long the broker waits, after this dispatcher stops renewing a job's lease, before redelivering its message.",
            ge=1,
        ),
    ]
    retention_ms: Annotated[
        int,
        Field(
            alias="retentionMs",
            description="How long a concluded job is kept before it is deleted.",
            ge=1,
        ),
    ]
    retention_sweep_ms: Annotated[
        int,
        Field(
            alias="retentionSweepMs",
            description="How often concluded jobs past `retentionMs` are deleted.",
            ge=1,
        ),
    ]
    progress_write_interval_ms: Annotated[
        int,
        Field(
            alias="progressWriteIntervalMs",
            description="The least time between two progress writes for one job; reports closer together than this are not written.",
            ge=1,
        ),
    ]
    boot_deadline_ms: Annotated[
        int,
        Field(
            alias="bootDeadlineMs",
            description="How long the dispatcher waits at boot for the broker before it exits, so that a restart policy can retry.",
            ge=1,
        ),
    ]


class DispatcherConfig(WireModel, frozen=True, extra="forbid"):
    """
    Everything the dispatcher reads at boot, resolved: no ${VAR} is left in it and nothing in it is defaulted by the dispatcher. The launcher writes it for the dispatcher it starts, from the environment the knowledge base's config selects, and the dispatcher reads it from the path its `--config` flag names (its image passes `/etc/semiont/dispatcher.json`). Started without `--config`, or with a path that names no file, the dispatcher refuses to start and says which. Secrets are never values here: a field that needs one names the environment variable holding it. The dispatcher's other inputs are the environment variables specs/src/service-environment/variables.json lists for it, and the ones this document names. A document that does not validate is refused at boot, naming each failing field.
    """

    gateway_url: Annotated[
        str,
        Field(
            alias="gatewayUrl",
            description="The URL the dispatcher reaches the gateway at: its only route to the bus.",
            min_length=1,
        ),
    ]
    identity: Annotated[
        Identity1,
        Field(description="The issuer the dispatcher's service account signs in at."),
    ]
    queue: Annotated[
        Queue,
        Field(description="The JetStream broker holding the job queue, whose layout is specs/src/jobs/storage.json."),
    ]
    port: Annotated[
        int,
        Field(description="The port the dispatcher answers `/health` on.", ge=1, le=65535),
    ]
    timing: Annotated[
        Timing,
        Field(
            description="The queue's clocks, in milliseconds. The launcher writes the values a deployment runs with; a test harness shrinks them."
        ),
    ]
    log_level: Annotated[LogLevel, Field(alias="logLevel")]
    log_format: Annotated[LogFormat, Field(alias="logFormat")]


class DispatcherHealth(WireModel, frozen=True, extra="forbid"):
    """
    The dispatcher's liveness answer. It answers only once its queue has connected and its bus pumps are attached, so a 200 means it can take work.
    """

    status: Literal["ok"]
    queue: Annotated[Literal["jetstream"], Field(description="The queue it holds.")]


class Identity2(WireModel, frozen=True, extra="forbid"):
    """
    The issuer the Archivist's service account signs in at, and whose tokens it admits callers of its HTTP surface by.
    """

    issuer: Annotated[
        str,
        Field(
            description="The issuer URL, exactly as tokens carry it in `iss`.",
            min_length=1,
        ),
    ]


class Staging(WireModel, frozen=True, extra="forbid"):
    """
    The bounds on how far the staging driver may run behind the working tree, in milliseconds. A knowledge base that does not sync git stages nothing, and reads neither.
    """

    flush_ms: Annotated[
        int,
        Field(
            alias="flushMs",
            description="The quiet period after the last change before pending changes are staged.",
            ge=1,
        ),
    ]
    max_wait_ms: Annotated[
        int,
        Field(
            alias="maxWaitMs",
            description="The longest a change waits to be staged while others keep arriving, measured from the oldest pending change.",
            ge=1,
        ),
    ]


class EntityTypesProjection(WireModel, frozen=True, extra="forbid"):
    """
    The knowledge base's entity-type vocabulary: the file `projections/__system__/entitytypes.json` under the state directory, the sum of the `frame:entity-type-added` events. Written as JSON indented by two spaces.
    """

    entity_types: Annotated[
        list[str],
        Field(
            alias="entityTypes",
            description="Every entity type added, each once, sorted.",
        ),
    ]


class TagSchemasProjection(WireModel, frozen=True, extra="forbid"):
    """
    The knowledge base's tag schemas: the file `projections/__system__/tagschemas.json` under the state directory, the sum of the `frame:tag-schema-added` events. Written as JSON indented by two spaces.
    """

    tag_schemas: Annotated[
        list[TagSchema],
        Field(
            alias="tagSchemas",
            description="Every tag schema added, sorted by `id`. A schema added again under an `id` replaces the one held.",
        ),
    ]


class People(WireModel, frozen=True, extra="forbid"):
    name: Annotated[str, Field(description="The name the person last gave.")]
    since: Annotated[str, Field(description="The timestamp of the event that gave it.")]


class PeopleProjection(WireModel, frozen=True, extra="forbid"):
    """
    What the people of a knowledge base are called: the file `projections/__system__/people.json` under the state directory, the sum of the `person:profiled` events. The Archivist writes it; the Archivist and the Librarian read it to name the people a reply mentions. Written as JSON indented by two spaces.
    """

    people: Annotated[
        dict[str, People],
        Field(description="Each person's current profile, keyed by their DID."),
    ]


class StorageUriEntry(WireModel, frozen=True, extra="forbid"):
    """
    One entry of the storage-uri index: the file `projections/storage-uri/<ab>/<cd>/<sha256 of the URI, hex>.json` under the state directory. It answers which resource's content is at a place in the working tree. Written as JSON indented by two spaces, `uri` first.
    """

    uri: Annotated[
        str,
        Field(description="The `file://` URI of a place in the working tree, relative to the knowledge base's root."),
    ]
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


type Word = Annotated[list[float], Field(max_length=4, min_length=4)]


class Line(WireModel, frozen=True, extra="forbid"):
    """
    One line of text: the words that share a page, a baseline and a height.
    """

    p: Annotated[int, Field(description="The page, counted from 1.")]
    y: Annotated[
        float,
        Field(description="The line's vertical position in PDF points, from the bottom of the page."),
    ]
    h: Annotated[float, Field(description="The line's height in PDF points.")]
    words: Annotated[
        list[Word],
        Field(
            description="Each word as `[x, width, start, end]`: its horizontal position and width in PDF points, and the offsets of its text in `text`."
        ),
    ]


class AnchoredTextExtractedEntry(WireModel, frozen=True, extra="forbid"):
    """
    The text extracted from the bytes, where each word is on the page, and how it was extracted.
    """

    v: Annotated[Literal[2], Field(description="The entry format.")]
    stamp: Annotated[
        str,
        Field(
            description="The stamp of the writer that derived the entry. A reader takes the entry only when it equals the stamp the writer states in the store's `STAMP` file.",
            min_length=1,
        ),
    ]
    text: Annotated[str, Field(description="The extracted text.")]
    lines: Annotated[
        list[Line],
        Field(description="Where each word of `text` is, line by line, in reading order."),
    ]
    method: Annotated[
        Literal["text-passthrough", "pdf-text-layer", "table", "form", "ocr"],
        Field(description="How the text was extracted."),
    ]
    pdf_class: Annotated[
        Literal["A", "B", "C", "D", "E", "F", "G"] | None,
        Field(
            alias="pdfClass",
            description="PDF classification, when the source was a PDF.",
        ),
    ] = None
    ocr_confidence: Annotated[
        OcrConfidence | None,
        Field(
            alias="ocrConfidence",
            description="How well the engine read the pixels, when any of this text came from OCR.",
        ),
    ] = None
    unread_pages: Annotated[
        list[int] | None,
        Field(
            alias="unreadPages",
            description="1-indexed pages this extraction could not read — present only for partially covered documents (class C).",
        ),
    ] = None


class AnchoredTextDeclinedEntry(WireModel, frozen=True, extra="forbid"):
    """
    The bytes were declined: no text is extracted from them.
    """

    v: Annotated[Literal[2], Field(description="The entry format.")]
    stamp: Annotated[
        str,
        Field(
            description="The stamp of the writer that derived the entry. A reader takes the entry only when it equals the stamp the writer states in the store's `STAMP` file.",
            min_length=1,
        ),
    ]
    declined: Annotated[
        Literal["no-text-layer", "encrypted", "corrupt", "too-large"],
        Field(description="Why extraction yielded nothing, by class."),
    ]


class ArchivistRosterRole(WireModel, frozen=True, extra="forbid"):
    """
    The agent serving one role: an inference provider and a model. With the knowledge base's domain, the pair is the agent's identity.
    """

    provider: Annotated[Literal["anthropic", "ollama"], Field(description="The inference provider.")]
    model: Annotated[
        str,
        Field(description="The model identifier, as the provider names it.", min_length=1),
    ]


class YieldMoveFailed(CommandError, frozen=True):
    """
    The payload of `yield:move-failed`: a CommandError that names the resource the move was asked of.
    """

    from_uri: Annotated[
        str,
        Field(
            alias="fromUri",
            description="The storage URI the resource was to be moved from.",
        ),
    ]


class GatherFailed(CommandError, frozen=True):
    """
    The payload of `gather:failed`: a CommandError that names the annotation whose context could not be gathered.
    """

    annotation_id: Annotated[
        AnnotationId,
        Field(alias="annotationId", description="The annotation the gather was asked for."),
    ]


class GatherResourceFailed(CommandError, frozen=True):
    """
    The payload of `gather:resource-failed`: a CommandError that names the resource whose context could not be gathered.
    """

    resource_id: Annotated[
        ResourceId,
        Field(alias="resourceId", description="The resource the gather was asked for."),
    ]


class BrowseDirectoryFailed(CommandError, frozen=True):
    """
    The payload of `browse:directory-failed`: a CommandError that names the directory that could not be read.
    """

    path: Annotated[str, Field(description="The path the read was asked for.")]


class MarkAssistTimeoutEvent(WireModel, frozen=True):
    """
    The payload of `mark:assist-timeout`, a client-local signal: an assist went silent past its deadline, with no progress, no completion and no `job:fail`. A real job failure arrives as `job:fail` and never produces this.
    """

    resource_id: Annotated[
        ResourceId,
        Field(alias="resourceId", description="The resource the assist was run on."),
    ]
    motivation: Motivation


class ResourceErrorEvent(WireModel, frozen=True):
    """
    A client-local notice that a command on a resource failed, for a UI to show: the payload of `mark:create-error`, `mark:delete-error` and `bind:body-error`. Emitted by the caller that awaited the command, which knows whose command failed on which resource. The `*-failed` wire replies are correlation plumbing and are not for this.
    """

    resource_id: Annotated[
        ResourceId,
        Field(alias="resourceId", description="The resource the command addressed."),
    ]
    message: Annotated[str, Field(description="Human-readable error message.")]


class JobCancelResult(WireModel, frozen=True):
    """
    What a cancel did, in the `response` of `job:cancel-ok`: how many jobs it cancelled. A pending job is cancelled outright; a running one is left to its worker, so for it the count means accepted, not stopped.
    """

    cancelled: Annotated[int, Field(description="The number of jobs cancelled.")]


class WeaveApplied(WireModel, frozen=True):
    """
    The payload of `weave:applied`: the Weaver has applied a resource's events to the graph up to this sequence number. Emitted after applying an event, or a batch's last event.
    """

    resource_id: Annotated[
        ResourceId,
        Field(alias="resourceId", description="The resource whose events were applied."),
    ]
    sequence_number: Annotated[
        int,
        Field(
            alias="sequenceNumber",
            description="The resource-stream sequence of the last applied event.",
        ),
    ]


class SmeltSettled(WireModel, frozen=True):
    """
    The payload of `smelt:settled`: the Smelter's decision for one resource's content, keyed by the checksum of the bytes it inspected. `indexed`: the content is in the vector index. `skipped`: it declined, and `reason` says why.
    """

    resource_id: Annotated[
        ResourceId,
        Field(alias="resourceId", description="The resource whose content was inspected."),
    ]
    content_checksum: Annotated[
        str,
        Field(alias="contentChecksum", description="The checksum of the bytes inspected."),
    ]
    outcome: Literal["indexed", "skipped"]
    reason: Annotated[
        Literal[
            "no-extractor",
            "empty",
            "no-text-layer",
            "encrypted",
            "corrupt",
            "too-large",
        ]
        | None,
        Field(description="Why the content was skipped."),
    ] = None


type Agent = Annotated[
    AgentPerson | AgentOrganization | AgentSoftware,
    Field(
        description="Web Annotation / W3C PROV Agent. Discriminated by @type — Person, Organization, or Software (named member schemas: AgentPerson, AgentOrganization, AgentSoftware). Software peers are first-class participants, not a sub-class of Person.",
        discriminator="type",
    ),
]


type Generator = Annotated[
    list[Agent],
    Field(
        description="Web Annotation generator — the Software peer that produced the annotation, when software did. Absent for a person's own annotation. An emitter may supply it to carry the model's parameters, but its identity must be the emitter's own: the knowledge base refuses a generator naming anyone else, and supplies it from the verified emitter when omitted. One producer per write — a write carrying the array form is refused.",
        min_length=1,
    ),
]


type WasAttributedTo = Annotated[
    list[Agent],
    Field(
        description="PROV-O wasAttributedTo — every party responsible for this annotation, DERIVED by the knowledge base from `creator` and the verified executor of the write: `[creator, generator]` when one agent requested the work and software produced it; collapsed to the one agent when requester and producer are the same. Never accepted from an emitter.",
        min_length=1,
    ),
]


type AnnotationBody = Annotated[
    TextualBody | SpecificResource,
    Field(
        description="An annotation's body: a TextualBody carries text the annotation states (entity tags, descriptions, comments), a SpecificResource points at what it links to. Tell them apart by `type`, which is required on both and single-valued — a consumer never has to probe for which fields happen to be present.",
        discriminator="type",
    ),
]


class AttributedEvent(StoredEventResponse, frozen=True):
    """
    A persisted event as a history reply carries it: the stored event, and the agent its `userId` identifies. The agent is derived when the reply is made — the DID read into a Person or a Software agent, and a Person's name filled in from the knowledge base's record of who its people are — and is stored nowhere. A Person the record does not name carries no `name`.
    """

    agent: Annotated[Agent, Field(description="Who `userId` is.")]


class BindBodyOperation(WireModel, frozen=True):
    """
    One edit to a linking annotation's body list: add or remove a body item, or replace an existing one.
    """

    op: Annotated[
        Literal["add", "remove", "replace"],
        Field(description="The type of body operation"),
    ]
    item: Annotated[AnnotationBody | None, Field(description="Body item for add operations")] = None
    old_item: Annotated[
        AnnotationBody | None,
        Field(alias="oldItem", description="Previous body item for replace operations"),
    ] = None
    new_item: Annotated[
        AnnotationBody | None,
        Field(alias="newItem", description="Replacement body item for replace operations"),
    ] = None


class BindUpdateBodyCommand(WireModel, frozen=True):
    """
    Command payload sent on the bind:update-body bus channel to modify annotation bodies.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    annotation_id: Annotated[
        AnnotationId,
        Field(
            alias="annotationId",
            description="Branded AnnotationId of the annotation whose body is being updated",
        ),
    ]
    resource_id: Annotated[
        ResourceId,
        Field(
            alias="resourceId",
            description="Branded ResourceId of the resource the annotation belongs to",
        ),
    ]
    operations: Annotated[list[BindBodyOperation], Field(description="Ordered body-list edits to apply.")]


class BodyOperationAdd(WireModel, frozen=True):
    op: Literal["add"]
    item: TextualBody | SpecificResource


class BodyOperationRemove(WireModel, frozen=True):
    op: Literal["remove"]
    item: TextualBody | SpecificResource


class BodyOperationReplace(WireModel, frozen=True):
    op: Literal["replace"]
    old_item: Annotated[TextualBody | SpecificResource, Field(alias="oldItem")]
    new_item: Annotated[TextualBody | SpecificResource, Field(alias="newItem")]


class BrowseEntityTypesResult(WireModel, frozen=True):
    """
    Result of browsing entity types
    """

    response: GetEntityTypesResponse


class BrowseKbResult(WireModel, frozen=True):
    """
    Result of browse:kb-requested
    """

    response: KbDescription


class BrowsePanelOpenEvent(WireModel, frozen=True):
    """
    Emitted when a browse panel is opened
    """

    panel: str
    scroll_to_annotation_id: Annotated[AnnotationId | None, Field(alias="scrollToAnnotationId")] = None
    motivation: Motivation | None = None


class AnchoredText(WireModel, frozen=True):
    """
    Text paired with the geometry that indexes it — the minimum needed to turn a character range into a selection, or a rectangle into a quote. Whole-resource: a producer iterates page by page, but every consumer wants one map.
    """

    text: Annotated[str, Field(description="Reading-order text of the whole resource.")]
    items: Annotated[
        list[PdfTextItem],
        Field(description="Positioned runs indexing `text`, roughly one per word."),
    ]


class CollaboratorEntry(WireModel, frozen=True):
    """
    One collaborator in the KB's directory: a W3C Agent plus, for software agents declared in the KB's worker inference config, the job types it serves. Actor-role-only agents (gatherer/matcher) and Persons omit servesJobTypes. The directory carries no inference limits: the services that hold the inference credentials report those (InferenceLimitsResult).
    """

    agent: Agent
    serves_job_types: Annotated[
        list[JobType] | None,
        Field(
            alias="servesJobTypes",
            description="Job types this agent is declared to serve (from the KB's workers.* config sections). Absent for Persons and for agents declared only under actor roles.",
        ),
    ] = None


type DirectoryEntry = Annotated[
    FileEntry | DirEntry,
    Field(
        description="One entry in a directory listing: a file, which may carry the resource it was ingested as, or a subdirectory. Tell them apart by `type`, which is required on both and single-valued.",
        discriminator="type",
    ),
]


class ExtractedText(AnchoredText, frozen=True):
    """
    A successful extraction: the anchored text plus its provenance. The 'extracted' member of ExtractionOutcome, the record the anchored-text store holds.
    """

    kind: Annotated[
        Literal["extracted"],
        Field(
            description="Discriminant — both ExtractionOutcome members carry `kind`, single-valued: the category here, the detail in `method`."
        ),
    ]
    method: Annotated[
        Literal["text-passthrough", "pdf-text-layer", "table", "form", "ocr"],
        Field(description="How the text was extracted."),
    ]
    pdf_class: Annotated[
        Literal["A", "B", "C", "D", "E", "F", "G"] | None,
        Field(
            alias="pdfClass",
            description="PDF classification, when the source was a PDF.",
        ),
    ] = None
    ocr_confidence: Annotated[
        OcrConfidence | None,
        Field(
            alias="ocrConfidence",
            description="How well the engine read the pixels, when any of this text came from OCR.",
        ),
    ] = None
    unread_pages: Annotated[
        list[int] | None,
        Field(
            alias="unreadPages",
            description="1-indexed pages this extraction could not read — present only for partially covered documents (class C).",
        ),
    ] = None


type ExtractionOutcome = Annotated[
    ExtractedText | ExtractionDeclined,
    Field(
        description="The full outcome of text extraction for one representation — the record the anchored-text store holds and the wire serves. Discriminated on `kind`: 'extracted' — the anchored text with its provenance; 'declined' — a named decline. ocrConfidence is extraction quality for operators, deliberately not anchor confidence.",
        discriminator="kind",
    ),
]


class FrameAddTagSchemaCommand(WireModel, frozen=True):
    """
    Bus command to register a tag schema with the KB's runtime registry. Carried on the `frame:add-tag-schema` channel — Frame is the schema-layer flow that owns vocabulary writes. Most-recent registration of a given `schema.id` wins; the projection reflects the latest content. Identical re-registrations are silent; differing content overwrites and logs a warning.
    """

    schema_: Annotated[TagSchema, Field(alias="schema")]
    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None


class GatherReferencedByResult(WireModel, frozen=True):
    """
    The annotations elsewhere that refer to a resource
    """

    response: GetReferencedByResponse


class SemanticContext(WireModel, frozen=True):
    """
    Semantically similar passages from across the knowledge base, found via vector search
    """

    similar: Annotated[
        list[SemanticMatch],
        Field(description="Passages ranked by cosine similarity to the focal text"),
    ]
    excluded_entity_types: Annotated[
        list[str] | None,
        Field(
            alias="excludedEntityTypes",
            description="Entity types excluded from this recall — a record of how `similar` was filtered (e.g. ['Question'] so answer-generation never surfaces prior questions). Absent when no exclusion was applied.",
        ),
    ] = None


class GetAnnotationHistoryResponse(WireModel, frozen=True):
    events: list[AttributedEvent]
    total: float
    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class GetEventsResponse(WireModel, frozen=True):
    events: list[AttributedEvent]
    total: float
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class GetTagSchemasResponse(WireModel, frozen=True):
    tag_schemas: Annotated[list[TagSchema], Field(alias="tagSchemas")]


class Response2(WireModel, frozen=True):
    limits: list[InferencePairLimits]


class InferenceLimitsResult(WireModel, frozen=True):
    """
    The inference limits one service discovered for its own (provider, model) pairs. A pair whose discovery is currently unavailable is absent.
    """

    response: Response2


class JobCancelCommand(WireModel, frozen=True):
    """
    A worker's confirmation that it has cooperatively stopped a running job at a unit boundary — the queue moves the job to cancelled/. Distinct from JobCancelRequest (the client→worker REQUEST to stop): this is the worker announcing it did, so the running job is never yanked to cancelled/ out from under a live worker (the roach-motel race).
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    job_id: Annotated[JobId, Field(alias="jobId")]
    job_type: Annotated[JobType, Field(alias="jobType")]
    annotation_id: Annotated[
        AnnotationId | None,
        Field(
            alias="annotationId",
            description="Annotation this job is attached to, when applicable. Lets the UI route cancellation feedback to a specific annotation.",
        ),
    ] = None
    completed_units: Annotated[
        list[str] | None,
        Field(
            alias="completedUnits",
            description="Entity-type units whose annotations were fully emitted before cancellation. Recorded on the cancelled job's metadata so the work already done stays visible.",
        ),
    ] = None
    unit_cursors: Annotated[
        dict[str, UnitCursor] | None,
        Field(
            alias="unitCursors",
            description="How far each in-progress unit got, keyed by unit — the grain `completedUnits` cannot express. A unit appearing here is NOT complete; a unit in `completedUnits` is skipped whole whatever cursor it last carried. Merged monotonically per unit: a stale snapshot must never move a cursor backward.",
        ),
    ] = None


class JobCompletedPayload(WireModel, frozen=True):
    """
    Payload for job:completed domain event
    """

    job_id: Annotated[JobId, Field(alias="jobId")]
    job_type: Annotated[JobType, Field(alias="jobType")]
    attempt: Annotated[
        int | None,
        Field(
            description="Which attempt produced this event, 1-based (a first run is 1). ALWAYS present: the queue re-runs a failed job silently, so an operator reading progress or a terminal record has no other way to tell a re-run from a first run — and provider spend, already counted in semiont_inference_tokens_total, cannot be attributed to a repeated document without it. Stated rather than inferred from absence, because 'attempt 1' is a fact the emitter always knows."
        ),
    ] = None
    annotation_id: Annotated[
        AnnotationId | None,
        Field(
            alias="annotationId",
            description="Annotation this job was attached to, when applicable",
        ),
    ] = None
    total_steps: Annotated[int | None, Field(alias="totalSteps")] = None
    found_count: Annotated[
        int | None,
        Field(alias="foundCount", description="For detection: total entities found"),
    ] = None
    result_resource_id: Annotated[
        ResourceId | None,
        Field(
            alias="resultResourceId",
            description="For generation: ID of generated resource",
        ),
    ] = None
    annotation_uri: Annotated[
        str | None,
        Field(
            alias="annotationUri",
            description="For generation: URI of annotation that triggered generation",
        ),
    ] = None
    result: Annotated[dict[str, JsonValue] | None, Field(description="Full result object for extensibility")] = None
    durability: DurabilityEvidence | None = None


class JobCreateCommand(WireModel, frozen=True):
    """
    Command to create a new job via the event bus
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    job_type: Annotated[JobType, Field(alias="jobType")]
    resource_id: Annotated[
        ResourceId | None,
        Field(
            alias="resourceId",
            description="Resource the job operates on. REQUIRED for every jobType EXCEPT 'generation', where it must be ABSENT: the dispatcher derives it from params.context.focus (the context is authoritative) and REJECTS a supplied value via job:create-failed. Both directions are enforced at the dispatcher — this schema cannot express the per-jobType conditionality.",
        ),
    ] = None
    params: dict[str, JsonValue]


class JobFailCommand(WireModel, frozen=True):
    """
    Command to mark a job as failed
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    job_id: Annotated[JobId, Field(alias="jobId")]
    job_type: Annotated[JobType, Field(alias="jobType")]
    attempt: Annotated[
        int | None,
        Field(
            description="Which attempt produced this event, 1-based (a first run is 1). ALWAYS present: the queue re-runs a failed job silently, so an operator reading progress or a terminal record has no other way to tell a re-run from a first run — and provider spend, already counted in semiont_inference_tokens_total, cannot be attributed to a repeated document without it. Stated rather than inferred from absence, because 'attempt 1' is a fact the emitter always knows."
        ),
    ] = None
    annotation_id: Annotated[
        AnnotationId | None,
        Field(
            alias="annotationId",
            description="Annotation this job is attached to, when applicable. Lets the UI route failure feedback (error toast, revert state) to a specific annotation.",
        ),
    ] = None
    error: str
    completed_units: Annotated[
        list[str] | None,
        Field(
            alias="completedUnits",
            description="Entity-type units whose annotations were fully emitted before this failure (checkpointed resume). The queue records them on the retried job's metadata; a retried claim skips them so completed work is neither redone nor duplicated.",
        ),
    ] = None
    unit_cursors: Annotated[
        dict[str, UnitCursor] | None,
        Field(
            alias="unitCursors",
            description="How far each in-progress unit got, keyed by unit — the grain `completedUnits` cannot express. A unit appearing here is NOT complete; a unit in `completedUnits` is skipped whole whatever cursor it last carried. Merged monotonically per unit: a stale snapshot must never move a cursor backward.",
        ),
    ] = None
    failure_class: Annotated[FailureClass | None, Field(alias="failureClass")] = None
    will_retry: Annotated[
        bool | None,
        Field(
            alias="willRetry",
            description="Whether the queue will re-queue this job for another attempt. Computed by the worker from the SAME predicate the queue applies at failJob (one decision site, `willRetryAfter` in @semiont/jobs) using the retry budget carried on the claimed record. FALSE (or absent) means this failure is TERMINAL: a client's job-watch stream ends here. TRUE means the work continues on a fresh attempt — the failure is an event, not the end, and a stream that terminated on it would report a recovering run as a failed one.",
        ),
    ] = None
    durability: DurabilityEvidence | None = None


class JobCheckpointCommand(WireModel, frozen=True):
    """
    Command to persist a running job's completed-unit checkpoint AT unit completion. Distinct from JobFailCommand's checkpoint, which lands only on a clean failure: a worker that dies (crash/OOM/kill) never emits job:fail, so this durable, unthrottled write is what lets the janitor's stale-running recovery resume a dead worker's job rather than redo its finished units.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    job_id: Annotated[JobId, Field(alias="jobId")]
    completed_units: Annotated[
        list[str],
        Field(
            alias="completedUnits",
            description="Entity-type units whose annotations have been fully emitted so far. Unioned into the running job's metadata checkpoint; a retry after recovery skips them.",
        ),
    ]
    unit_cursors: Annotated[
        dict[str, UnitCursor] | None,
        Field(
            alias="unitCursors",
            description="How far each in-progress unit got, keyed by unit — the grain `completedUnits` cannot express. A unit appearing here is NOT complete; a unit in `completedUnits` is skipped whole whatever cursor it last carried. Merged monotonically per unit: a stale snapshot must never move a cursor backward.",
        ),
    ] = None


class JobFailedPayload(WireModel, frozen=True):
    """
    Payload for the job:failed domain event — a permanent fact of the resource, not operational state. It carries the judgments the worker COMPUTED, not just its message: at the log they are otherwise unrecoverable, the only remaining witness being a flattened English string.
    """

    job_id: Annotated[JobId, Field(alias="jobId")]
    job_type: Annotated[JobType, Field(alias="jobType")]
    attempt: Annotated[
        int | None,
        Field(
            description="Which attempt produced this event, 1-based (a first run is 1). ALWAYS present: the queue re-runs a failed job silently, so an operator reading progress or a terminal record has no other way to tell a re-run from a first run — and provider spend, already counted in semiont_inference_tokens_total, cannot be attributed to a repeated document without it. Stated rather than inferred from absence, because 'attempt 1' is a fact the emitter always knows."
        ),
    ] = None
    annotation_id: Annotated[
        AnnotationId | None,
        Field(
            alias="annotationId",
            description="Annotation this job was attached to, when applicable",
        ),
    ] = None
    error: str
    failure_class: Annotated[FailureClass | None, Field(alias="failureClass")] = None
    will_retry: Annotated[
        bool | None,
        Field(
            alias="willRetry",
            description="Whether the worker computed that the queue would re-queue this job (same predicate the queue applies, `willRetryAfter`). Absent means the worker stated nothing. Without it a reader of the log cannot tell a run recovering across several job:failed events from that many dead jobs.",
        ),
    ] = None
    durability: DurabilityEvidence | None = None


type JobProgressMessage = Annotated[
    JobProgressLoading
    | JobProgressAnalyzing
    | JobProgressAnalyzingTags
    | JobProgressGeneratingResource
    | JobProgressCreatingResource
    | JobProgressCompleteGenerated
    | JobProgressDetectingEntities
    | JobProgressCreatingAnnotations
    | JobProgressCreatingTagAnnotations
    | JobProgressCompleteCreated,
    Field(
        description="What a running job is doing right now, as a code plus typed params — never a prose sentence. The producer reports what happened; each client renders it in the user's language (react-ui from its translations, the Go launcher from its English map). One named schema per code, discriminated on `code`, so generated clients get typed variants and copy-map completeness is statically checkable. The vocabulary is the census of every onProgress call site in @semiont/jobs; extending it means adding a named variant here and copy in every client, gated by the locale-completeness check.",
        discriminator="code",
    ),
]


type JobResult = Annotated[
    JobGenerationResult
    | JobReferenceAnnotationResult
    | JobHighlightAnnotationResult
    | JobAssessmentAnnotationResult
    | JobCommentAnnotationResult
    | JobTagAnnotationResult
    | JobDeclinedResult,
    Field(
        description="Discriminated union of all job result types — every member carries a single-valued `kind`. Consumers switch on `kind`; generated clients get typed variants.",
        discriminator="kind",
    ),
]


class JobStartCommand(WireModel, frozen=True):
    """
    Command to start a job
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    job_id: Annotated[JobId, Field(alias="jobId")]
    job_type: Annotated[JobType, Field(alias="jobType")]
    annotation_id: Annotated[
        AnnotationId | None,
        Field(
            alias="annotationId",
            description="Annotation this job is attached to, when applicable. Set for annotation-scoped jobs like generation (from a specific reference). Unset for resource-scoped jobs like bulk reference/tag/highlight detection.",
        ),
    ] = None
    attempt: Annotated[
        int | None,
        Field(
            description="Which attempt produced this event, 1-based (a first run is 1). ALWAYS present: the queue re-runs a failed job silently, so an operator reading progress or a terminal record has no other way to tell a re-run from a first run — and provider spend, already counted in semiont_inference_tokens_total, cannot be attributed to a repeated document without it. Stated rather than inferred from absence, because 'attempt 1' is a fact the emitter always knows."
        ),
    ] = None


class JobAssignCommand(WireModel, frozen=True):
    """
    Bus command the dispatcher emits, under its own service identity, immediately after it accepts a job:claim — the correlated job:claimed reply is unchanged. The Stower persists it as job:assigned. It is the one fact only the dispatcher can vouch for: which holder took which job, and who requested it. A later write citing `jobId` is checked against the holder and its `creator` derived from the requester by reading the resource's own log, with nothing outside the record.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="The dispatcher's service DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    job_id: Annotated[JobId, Field(alias="jobId")]
    job_type: Annotated[JobType, Field(alias="jobType")]
    resource_id: Annotated[
        ResourceId,
        Field(
            alias="resourceId",
            description="The job's resource — for a generation, the source it generates from. The assignment is persisted on this resource's log.",
        ),
    ]
    holder: Annotated[
        UserId,
        Field(
            description="DID of the claimant whose claim was accepted — the `_userId` the gateway stamped on the job:claim, restated by the dispatcher."
        ),
    ]
    requester: Annotated[
        UserId,
        Field(
            description="DID of the emitter of the job:create that produced this job — the `_userId` the gateway stamped on that create, restated by the dispatcher."
        ),
    ]


class JobStartedPayload(WireModel, frozen=True):
    """
    Payload for job:started domain event
    """

    job_id: Annotated[JobId, Field(alias="jobId")]
    job_type: Annotated[JobType, Field(alias="jobType")]
    annotation_id: Annotated[
        AnnotationId | None,
        Field(
            alias="annotationId",
            description="Annotation this job is attached to, when applicable",
        ),
    ] = None
    total_steps: Annotated[int | None, Field(alias="totalSteps")] = None


class JobAssignedPayload(WireModel, frozen=True):
    """
    Payload for job:assigned — the dispatcher's own record that it accepted a claim. Emitted by the dispatcher under its service identity after a successful job:claim (the correlated job:claimed reply is unchanged). This is the one fact only the dispatcher can vouch for: which holder took which job, and who requested it. The Stower persists it beside job:started so that a write citing `jobId` can be checked against the holder and its `creator` derived from the requester with no read outside the event log.
    """

    job_id: Annotated[JobId, Field(alias="jobId")]
    job_type: Annotated[JobType, Field(alias="jobType")]
    resource_id: Annotated[
        ResourceId,
        Field(
            alias="resourceId",
            description="The job's resource — for a generation, the source it generates from. Job events are scoped here.",
        ),
    ]
    holder: Annotated[
        UserId,
        Field(
            description="DID of the emitter whose claim the dispatcher accepted. The bus stamped it on the job:claim as `_userId`; the dispatcher restates it here under its own identity."
        ),
    ]
    requester: Annotated[
        UserId,
        Field(
            description="DID of the emitter of the job:create that produced this job. The dispatcher restates the `_userId` the gateway stamped on that create."
        ),
    ]


class MarkAssistRequestEvent(WireModel, frozen=True):
    """
    Emitted when the user requests AI assistance for a mark
    """

    motivation: Motivation
    options: Options1


class MarkUpdateBodyCommand(WireModel, frozen=True):
    """
    Bus command to update an annotation's body with patch operations.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    operations: list[BodyOperationAdd | BodyOperationRemove | BodyOperationReplace]


class ResourceClonedPayload(WireModel, frozen=True):
    """
    Payload for yield:cloned domain event
    """

    name: str
    format: ContentFormat
    content_checksum: Annotated[str, Field(alias="contentChecksum")]
    content_byte_size: Annotated[int | None, Field(alias="contentByteSize")] = None
    storage_uri: Annotated[
        str | None,
        Field(
            alias="storageUri",
            description="Where the clone's bytes are, on the resource's primary Representation — the same single home `yield:created` writes to.",
        ),
    ] = None
    parent_resource_id: Annotated[ResourceId, Field(alias="parentResourceId")]
    entity_types: Annotated[list[str] | None, Field(alias="entityTypes")] = None
    language: str | None = None
    creator: Annotated[
        Agent | None,
        Field(
            description="Who made the clone — the emitter, derived at write time. A clone is never job-fulfilling. Absent on events written before derivation existed, whose emitter was their only party."
        ),
    ] = None
    was_attributed_to: Annotated[
        Agent | list[Agent] | None,
        Field(
            alias="wasAttributedTo",
            description="PROV-O wasAttributedTo, derived at write time: the cloner alone. The value the resource view carries.",
        ),
    ] = None


class ResourceCreatedPayload(WireModel, frozen=True):
    """
    Payload for yield:created domain event
    """

    name: str
    format: ContentFormat
    content_checksum: Annotated[str, Field(alias="contentChecksum", description="SHA-256 of content")]
    content_byte_size: Annotated[int | None, Field(alias="contentByteSize")] = None
    entity_types: Annotated[list[str] | None, Field(alias="entityTypes")] = None
    storage_uri: Annotated[
        str | None,
        Field(
            alias="storageUri",
            description="The creating instruction's URI, recorded on the event. Append-only, so this value never changes — the LOCATION the projection serves is maintained across moves and lives on the resource's primary Representation, relocated by yield:moved. Optional: a resource may have no bytes. Working-tree URI, only file:// is supported (e.g. file://docs/overview.md).",
        ),
    ] = None
    language: str | None = None
    is_draft: Annotated[bool | None, Field(alias="isDraft")] = None
    generated_from: Annotated[GeneratedFrom | None, Field(alias="generatedFrom")] = None
    generation_prompt: Annotated[str | None, Field(alias="generationPrompt")] = None
    generator: Agent | list[Agent] | None = None
    creator: Annotated[
        Agent | None,
        Field(
            description="Who requested this resource — derived by the knowledge base at write time, never sent by the emitter. For a resource created in fulfilment of a job, the requester recorded on that job's job:assigned; otherwise the emitter itself. Absent on events written before derivation existed, whose emitter was their only party."
        ),
    ] = None
    was_attributed_to: Annotated[
        Agent | list[Agent] | None,
        Field(
            alias="wasAttributedTo",
            description="PROV-O wasAttributedTo, derived at write time from `creator` and the executor: both parties when they differ, one when they are the same. The value the resource view carries; readers do not re-derive it.",
        ),
    ] = None


class ResourceDescriptor(WireModel, frozen=True, extra="allow"):
    """
    Metadata about a resource (1:1 with its URI). JSON-LD subject is @id. Link to concrete bytes via representations.
    """

    context: Annotated[
        str | dict[str, JsonValue] | list[str | dict[str, JsonValue]],
        Field(
            alias="@context",
            description="JSON-LD context; URI, object, or array of these.",
        ),
    ]
    id: Annotated[
        ResourceId,
        Field(alias="@id", description="The id of the resource being described."),
    ]
    type: Annotated[
        str | Type1 | None,
        Field(
            alias="@type",
            description="Type(s) of the resource (IRIs/CURIEs via @context).",
        ),
    ] = None
    name: str
    description: str | None = None
    identifier: Annotated[
        str | Identifier | Identifier1 | None,
        Field(description="Persistent identifiers (e.g., DOI, URN)."),
    ] = None
    about: Annotated[str | About | None, Field(description="Topics (IRIs or strings).")] = None
    same_as: Annotated[
        list[str] | None,
        Field(alias="sameAs", description="Equivalent/authoritative references."),
    ] = None
    is_part_of: Annotated[list[str] | None, Field(alias="isPartOf")] = None
    has_part: Annotated[list[str] | None, Field(alias="hasPart")] = None
    license: str | None = None
    version: str | None = None
    date_created: Annotated[str | None, Field(alias="dateCreated")] = None
    date_modified: Annotated[str | None, Field(alias="dateModified")] = None
    was_derived_from: Annotated[
        ResourceId | list[ResourceId] | None,
        Field(
            alias="wasDerivedFrom",
            description="W3C PROV: the resource, or resources, this one was derived from, each by its id",
        ),
    ] = None
    was_attributed_to: Annotated[
        Agent | list[Agent] | None,
        Field(
            alias="wasAttributedTo",
            description="W3C PROV — every party responsible for this resource, derived by the knowledge base at creation from verified identities: `[requester, generator]` for a resource a job produced, collapsed to the one agent when the requester produced it. Never accepted from an emitter.",
        ),
    ] = None
    generator: Annotated[
        Agent | list[Agent] | None,
        Field(
            description="Software peer that produced this resource (W3C Web Annotation model). Its identity is the verified emitter of the create; the parameters are the producer's to state."
        ),
    ] = None
    conforms_to: Annotated[
        str | list[str] | None,
        Field(
            alias="conformsTo",
            description="Profile/shape URI this resource description conforms to.",
        ),
    ] = None
    available_formats: Annotated[
        list[str] | None,
        Field(
            alias="availableFormats",
            description="Convenience set summarizing media types across representations.",
        ),
    ] = None
    representations: Annotated[
        Representation | list[Representation],
        Field(description="Managed or referenced byte-level renditions of this resource."),
    ]
    archived: Annotated[
        bool | None,
        Field(description="Application-specific: Whether this resource is archived"),
    ] = None
    entity_types: Annotated[
        list[str] | None,
        Field(
            alias="entityTypes",
            description="Application-specific: Entity types for this resource",
        ),
    ] = None
    is_draft: Annotated[
        bool | None,
        Field(
            alias="isDraft",
            description="Application-specific: Whether this resource is a draft",
        ),
    ] = None
    source_annotation_id: Annotated[
        AnnotationId | None,
        Field(
            alias="sourceAnnotationId",
            description="Application-specific: ID of annotation that triggered generation",
        ),
    ] = None
    source_resource_id: Annotated[
        ResourceId | None,
        Field(
            alias="sourceResourceId",
            description="Application-specific: ID of source resource for clones/derivatives",
        ),
    ] = None
    originated_from: Annotated[
        str | None,
        Field(
            alias="originatedFrom",
            description="Original URI from a source knowledge base when this resource was imported",
        ),
    ] = None


class ScoredResource(ResourceDescriptor, frozen=True):
    """
    A resource returned by a search, carrying its relevance score and the reason it matched.
    """

    score: Annotated[
        float | None,
        Field(description="Relevance score assigned by the matcher; higher is a better candidate."),
    ] = None
    match_reason: Annotated[
        str | None,
        Field(alias="matchReason", description="Human-readable reason for the match."),
    ] = None


type Selector = Annotated[
    TextPositionSelector | TextQuoteSelector | SvgSelector | FragmentSelector,
    Field(
        description="One W3C selector: a way of finding a segment of a resource. Tell them apart by `type`, which is required on each and single-valued.",
        discriminator="type",
    ),
]


class UpdateAnnotationBodyRequest(WireModel, frozen=True):
    resource_id: Annotated[
        ResourceId,
        Field(
            alias="resourceId",
            description="Resource ID containing the annotation (required for O(1) Layer 3 lookup)",
        ),
    ]
    operations: Annotated[
        list[BodyOperationAdd | BodyOperationRemove | BodyOperationReplace],
        Field(description="Array of body modification operations to apply", min_length=1),
    ]


class YieldCreateCommand(WireModel, frozen=True):
    """
    Bus command to create a yielded resource in the knowledge base.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    roles: Annotated[
        list[str] | None,
        Field(
            alias="_roles",
            description="The emitter's capabilities (the token's `roles`), injected by the /bus/emit gateway. Clients do not set this. An emitter carrying the worker role must cite the job this resource fulfils in `jobId`; the Stower refuses the create otherwise.",
        ),
    ] = None
    job_id: Annotated[
        JobId | None,
        Field(
            alias="jobId",
            description="The job this resource fulfils. Required when the emitter carries the worker role; absent for self-initiated work (a person, or an agent acting on its own). The knowledge base derives who requested this resource from the cited job's own events — the emitter never says who the work was for.",
        ),
    ] = None
    name: str
    storage_uri: Annotated[
        str,
        Field(
            alias="storageUri",
            description="The caller's instruction for WHERE the bytes are — not a copy of the stored fact. The stored location lives on the resource's primary Representation (`Representation.storageUri`), which is its single home; this field is the message that puts it there. Working-tree URI, only file:// is supported (e.g. file://docs/overview.md).",
        ),
    ]
    content_checksum: Annotated[str, Field(alias="contentChecksum")]
    byte_size: Annotated[int, Field(alias="byteSize")]
    format: ContentFormat
    language: str | None = None
    entity_types: Annotated[list[str] | None, Field(alias="entityTypes")] = None
    is_draft: Annotated[bool | None, Field(alias="isDraft")] = None
    generated_from: Annotated[GeneratedFrom1 | None, Field(alias="generatedFrom")] = None
    generation_prompt: Annotated[str | None, Field(alias="generationPrompt")] = None
    generator: Annotated[
        Agent | list[Agent] | None,
        Field(
            description="The Software peer that produced the content, when software did. Its identity must be the emitter's own — the knowledge base refuses a generator naming anyone else, and supplies it from the verified emitter when omitted. `creator` and `wasAttributedTo` are never sent; the knowledge base derives them from the emitter and the cited job."
        ),
    ] = None


class BusEventMessage(WireModel, frozen=True, extra="forbid"):
    """
    A bus frame on the stream: `event: bus-event`, an `id:` line, and one `data:` line holding the JSON-serialised BusFrame. This schema describes the message with `data` already parsed.
    """

    event: Literal["bus-event"]
    id: PersistedEventId | ReplyEventId | EphemeralEventId
    data: BusFrame


type BusStreamMessage = Annotated[
    BusEventMessage | BusPingMessage,
    Field(description="Every message the bus stream carries. A client ignores an `event` it does not know; the gateway writes no other."),
]


class GatewayConfig(WireModel, frozen=True, extra="forbid"):
    """
    Everything the gateway reads at boot, resolved: no ${VAR} is left in it and nothing in it is defaulted by the gateway. The launcher writes it for the gateway it starts — from the knowledge base's committed identity and the environment its config selects — and a gateway started any other way is given the same document at the path its `--config` flag names (the image passes `/etc/semiont/gateway.json`). Started without `--config`, or with a path that names no file, the gateway refuses to start and says which. Secrets are never values here: a field that needs one names the environment variable holding it. The gateway's other inputs are the environment variables specs/src/service-environment/variables.json lists for it, and the ones this document names. A document that does not validate is refused at boot — the gateway exits without serving — and the refusal names each failing field by its JSON pointer.
    """

    kb: Annotated[
        Kb,
        Field(description="The knowledge base's committed identity (`[project] name` and `[site] domain` in its .semiont/config)."),
    ]
    port: Annotated[
        int,
        Field(
            description="The port the gateway listens on, on every address the host has: IPv4 and IPv6.",
            ge=1,
            le=65535,
        ),
    ]
    public_url: Annotated[
        str,
        Field(
            alias="publicUrl",
            description="The URL clients reach this gateway at: the `servers` entry of the OpenAPI document it serves.",
            min_length=1,
        ),
    ]
    identity: Annotated[Identity, Field(description="The issuer this knowledge base trusts.")]
    archivist: Annotated[Archivist, Field(description="Where the Archivist listens.")]
    signal: Annotated[
        Signal,
        Field(
            description="The signal plane: `in-process`, one gateway on its own fabric; or `nats`, the fabric every replica on one broker shares, which requires `servers` and a broker with JetStream."
        ),
    ]
    log_level: Annotated[LogLevel, Field(alias="logLevel")]
    log_format: Annotated[LogFormat, Field(alias="logFormat")]
    capacity: Annotated[
        Capacity,
        Field(
            description="What this gateway process can hold, from the memory its deployment gives it. `queuedBytes`: the bytes queued for all its streams together; at it, a new stream is refused with 503 (`AtCapacity`, code `capacity`) until the queues drain — each stream's own bound is `x-semiont-limits.pendingWriteBytes`. `connections`: the connections it holds open at once; one past it is closed unanswered. The launcher derives both from the memory it gives the gateway's container."
        ),
    ]


type JobStoredResult = Annotated[
    JobResult | dict[str, JsonValue],
    Field(
        description="A completed job's result as the dispatcher stores it: the result its worker reported with `job:complete`, or an empty object when it reported none."
    ),
]


class JobComplete(WireModel, frozen=True, extra="forbid"):
    """
    A job its worker completed.
    """

    status: Literal["complete"]
    metadata: JobMetadata
    params: JobParams
    started_at: Annotated[
        str,
        Field(alias="startedAt", description="When the claim that completed it was made."),
    ]
    completed_at: Annotated[str, Field(alias="completedAt", description="When it completed.")]
    result: JobStoredResult


type AnchoredTextEntry = Annotated[
    AnchoredTextExtractedEntry | AnchoredTextDeclinedEntry,
    Field(
        description="One entry of the anchored-text store: the file `<ab>/<cd>/<key>.json` under the store's directory, where the key is the SHA-256 of the bytes the text was extracted from, in hex. The Smelter writes it; the Archivist reads it. Written as compact JSON, `v` and `stamp` first, by writing a sibling temporary file and renaming it onto the path. The store's writer states its current stamp, followed by a newline, in the file `STAMP` at the store's root."
    ),
]


class Workers(WireModel, frozen=True, extra="forbid"):
    """
    The agent serving each job type.
    """

    reference_annotation: Annotated[ArchivistRosterRole | None, Field(alias="reference-annotation")] = None
    highlight_annotation: Annotated[ArchivistRosterRole | None, Field(alias="highlight-annotation")] = None
    assessment_annotation: Annotated[ArchivistRosterRole | None, Field(alias="assessment-annotation")] = None
    comment_annotation: Annotated[ArchivistRosterRole | None, Field(alias="comment-annotation")] = None
    tag_annotation: Annotated[ArchivistRosterRole | None, Field(alias="tag-annotation")] = None
    generation: ArchivistRosterRole | None = None


class Actors(WireModel, frozen=True, extra="forbid"):
    """
    The agent serving each actor that calls a model.
    """

    gatherer: ArchivistRosterRole | None = None
    matcher: ArchivistRosterRole | None = None


class ArchivistRoster(WireModel, frozen=True, extra="forbid"):
    """
    Who serves each role, behind `browse:agents`: a provider and a model, and no credential. Every fallback the knowledge base's config allows is already applied, so a role absent here is served by no one.
    """

    workers: Annotated[Workers, Field(description="The agent serving each job type.")]
    actors: Annotated[Actors, Field(description="The agent serving each actor that calls a model.")]


type AnnotationBodies1 = Annotated[
    list[AnnotationBody],
    Field(
        description="Non-empty array of mixed TextualBody (tagging) and SpecificResource (linking) bodies",
        min_length=1,
    ),
]


type AnnotationBodies = Annotated[
    AnnotationBody | AnnotationBodies1,
    Field(
        description="What an annotation's `body` holds: one body, or a non-empty list of them. There is no empty list: an annotation with nothing to say has no `body`."
    ),
]


class AnnotationBodyUpdatedPayload(WireModel, frozen=True):
    """
    Payload for mark:body-updated domain event
    """

    annotation_id: Annotated[AnnotationId, Field(alias="annotationId")]
    operations: list[BodyOperationAdd | BodyOperationRemove | BodyOperationReplace]


type AnnotationSelector = Annotated[
    Selector | list[Selector],
    Field(description="What a target's `selector` holds: one W3C selector, or several of the same segment."),
]


class AnnotationTarget(WireModel, frozen=True):
    """
    W3C Web Annotation target object - source is required, selector is optional
    """

    source: Annotated[ResourceId, Field(description="The id of the resource being annotated")]
    selector: Annotated[
        AnnotationSelector | None,
        Field(description="Optional selector to identify a specific segment of the source resource"),
    ] = None


class Response(WireModel, frozen=True):
    agents: list[CollaboratorEntry]


class BrowseAgentsResult(WireModel, frozen=True):
    """
    Result of browsing the collaborator directory
    """

    response: Response


class BrowseAnnotationHistoryResult(WireModel, frozen=True):
    """
    Result of browsing annotation history
    """

    response: GetAnnotationHistoryResponse


class Response1(WireModel, frozen=True):
    path: str
    entries: list[DirectoryEntry]


class BrowseDirectoryResult(WireModel, frozen=True):
    """
    Result of browsing a directory listing
    """

    response: Response1


class BrowseEventsResult(WireModel, frozen=True):
    """
    Result of browsing events for a resource
    """

    response: GetEventsResponse


class BrowseFilesResponse(WireModel, frozen=True, extra="forbid"):
    path: Annotated[
        str,
        Field(description="The directory path that was listed, relative to project root"),
    ]
    entries: list[DirectoryEntry]


type AnchoredTextAnswer = Annotated[
    ExtractedText | ExtractionDeclined | AnchoredTextAbsent,
    Field(
        description="What a reader gets when it asks for a resource's coordinate map: the map, a stored decline, or a named absence.\n\nDistinct from `ExtractionOutcome` on purpose. That type is what the STORE holds and what an extractor RETURNS — neither of which can ever be 'not yet'. This is the read answer, which can, so widening ExtractionOutcome itself would have put an impossible state into the store's own type.\n\nFlat, one discriminant: every member carries `kind`, rather than nesting an outcome inside a status envelope and giving the wire two `kind` fields at different depths.",
        discriminator="kind",
    ),
]


class BrowseTagSchemasResult(WireModel, frozen=True):
    """
    Result of browsing tag schemas
    """

    response: GetTagSchemasResponse


class CloneResourceWithTokenResponse(WireModel, frozen=True):
    token: Annotated[str, Field(description="Generated clone token")]
    expires_at: Annotated[
        str,
        Field(alias="expiresAt", description="ISO 8601 timestamp when token expires"),
    ]
    resource: ResourceDescriptor


class CreateAnnotationRequest(WireModel, frozen=True):
    motivation: Motivation
    target: AnnotationTarget
    body: Annotated[
        AnnotationBodies | None,
        Field(
            description="Optional body. Omit for annotations whose motivation alone is meaningful (highlighting) or whose user-supplied content is empty. Shape matches Annotation.body."
        ),
    ] = None


class Focus1(WireModel, frozen=True):
    """
    Whole-resource focus.
    """

    kind: Literal["resource"]
    resource: Annotated[
        ResourceDescriptor,
        Field(description="The resource this context was gathered for"),
    ]
    summary: str | None = None
    suggested_references: Annotated[list[str] | None, Field(alias="suggestedReferences")] = None
    content: Annotated[Content | None, Field(description="Resource content (included when requested)")] = None


class GetResourceByTokenResponse(WireModel, frozen=True):
    source_resource: Annotated[ResourceDescriptor, Field(alias="sourceResource")]
    expires_at: Annotated[
        str,
        Field(alias="expiresAt", description="ISO 8601 timestamp when token expires"),
    ]


class JobCompleteCommand(WireModel, frozen=True):
    """
    Command to mark a job as complete
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    job_id: Annotated[JobId, Field(alias="jobId")]
    job_type: Annotated[JobType, Field(alias="jobType")]
    attempt: Annotated[
        int | None,
        Field(
            description="Which attempt produced this event, 1-based (a first run is 1). ALWAYS present: the queue re-runs a failed job silently, so an operator reading progress or a terminal record has no other way to tell a re-run from a first run — and provider spend, already counted in semiont_inference_tokens_total, cannot be attributed to a repeated document without it. Stated rather than inferred from absence, because 'attempt 1' is a fact the emitter always knows."
        ),
    ] = None
    annotation_id: Annotated[
        AnnotationId | None,
        Field(
            alias="annotationId",
            description="Annotation this job is attached to, when applicable. Lets the UI route completion feedback (toast, resolve state) to a specific annotation.",
        ),
    ] = None
    result: JobResult | None = None
    durability: DurabilityEvidence | None = None


class JobProgress(WireModel, frozen=True):
    """
    Progress report from a running job. The required field is `percentage`; `message` carries the coded phase and the rest are optional job-shape fields. This is the single progress shape for every job type — annotation workers and generation alike. Terminality is signalled on `job:complete` / `job:fail`, not here. A flow that iterates a user-chosen list (entity types for references, categories for tags) reports its position as one `current`/`processed`/`total` triple, the same shape for both, so a client never needs to know which flow it is drawing.
    """

    percentage: Annotated[float, Field(description="Completion percentage (0-100)")]
    message: Annotated[
        JobProgressMessage | None,
        Field(
            description="What the job is doing right now, as a code plus typed params; the client renders the sentence. Optional: pure percentage heartbeats carry none, and consumers render nothing message-shaped when it is absent."
        ),
    ] = None
    annotation_id: Annotated[
        AnnotationId | None,
        Field(
            alias="annotationId",
            description="Annotation this job is attached to, when applicable. Echoed inside JobProgress (in addition to the outer command envelope) so consumers that only see the inner progress object (e.g. client.yield.fromContext's Observable) can still route visual feedback to a specific annotation.",
        ),
    ] = None
    current: Annotated[
        Current | None,
        Field(
            description="What the run is working on right now. `kind` is a CODE the client renders a localized name for; `value` is KB data (an entity type, a tag category) shown verbatim — the same split as `requestParams`. Absent on flows that iterate nothing, such as generation."
        ),
    ] = None
    processed: Annotated[
        int | None,
        Field(description="Items completed so far, zero-based — the item in `current` is the one after these. Paired with `total`."),
    ] = None
    total: Annotated[int | None, Field(description="Items this run will process in all.")] = None
    entities_found: Annotated[
        int | None,
        Field(
            alias="entitiesFound",
            description="Entities found so far (reference-annotation)",
        ),
    ] = None
    entities_expected: Annotated[
        int | None,
        Field(
            alias="entitiesExpected",
            description="Cumulative mentions the count-verifier priced across the pieces accepted so far — the denominator for a real progress bar (found of ~expected). Approximate by nature (the count saturates on very large pieces) and monotonically growing within a run. ABSENT when the provider does not verify detection yield, or before any piece has been priced: no claim, never zero.",
        ),
    ] = None
    entities_emitted: Annotated[
        int | None,
        Field(
            alias="entitiesEmitted",
            description="Annotations emitted so far (reference-annotation)",
        ),
    ] = None
    completed_items: Annotated[
        list[CompletedItem] | None,
        Field(
            alias="completedItems",
            description="Per-item results for the items already finished, for the UI's completed log. Generic across flows for the same reason `current` is.",
        ),
    ] = None
    request_params: Annotated[
        list[RequestParam] | None,
        Field(
            alias="requestParams",
            description="Echoed job parameters for display in the progress UI. `label` is a CODE, not a sentence — the client owns the wording, same rule as the progress message. `value` is the user's own input (an entity-type list, their instructions) and is deliberately NOT translated: it is their words, not ours.",
        ),
    ] = None


class JobReportProgressCommand(WireModel, frozen=True):
    """
    Command to report progress on a job
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    job_id: Annotated[JobId, Field(alias="jobId")]
    job_type: Annotated[JobType, Field(alias="jobType")]
    attempt: Annotated[
        int | None,
        Field(
            description="Which attempt produced this event, 1-based (a first run is 1). ALWAYS present: the queue re-runs a failed job silently, so an operator reading progress or a terminal record has no other way to tell a re-run from a first run — and provider spend, already counted in semiont_inference_tokens_total, cannot be attributed to a repeated document without it. Stated rather than inferred from absence, because 'attempt 1' is a fact the emitter always knows."
        ),
    ] = None
    annotation_id: Annotated[
        AnnotationId | None,
        Field(
            alias="annotationId",
            description="Annotation this job is attached to, when applicable. Lets the UI attach progress visuals to a specific annotation (e.g. a reference whose generation is running).",
        ),
    ] = None
    percentage: float
    progress: JobProgress | None = None


class ListResourcesResponse(WireModel, frozen=True):
    resources: list[ResourceDescriptor]
    total: float
    offset: float
    limit: float


class MarkCreateRequest(WireModel, frozen=True):
    """
    Raw annotation creation intent — bus handler assembles the W3C annotation
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    request: CreateAnnotationRequest


class MarkRequestedEvent(WireModel, frozen=True):
    """
    Emitted when the user requests a new mark (annotation) on a resource
    """

    source: Annotated[
        ResourceId,
        Field(
            description="The '@id' of the resource the mark belongs to (W3C target.source). Routes the event to the right viewer/state unit when a host mounts many viewers on one session."
        ),
    ]
    selector: Annotated[AnnotationSelector, Field(description="One or more W3C selectors")]
    motivation: Motivation


class MarkSubmitEvent(WireModel, frozen=True):
    """
    Emitted when a mark is submitted with its annotation body
    """

    source: Annotated[
        ResourceId,
        Field(
            description="The '@id' of the resource the mark belongs to (W3C target.source). Routes the submit to the state unit bound to that resource — without it, N mounted units each create the annotation (N copies on N resources)."
        ),
    ]
    motivation: Motivation
    selector: Annotated[AnnotationSelector, Field(description="One or more W3C selectors")]
    body: Annotated[
        AnnotationBodies | None,
        Field(
            description="Optional body. Omit for annotations whose motivation alone is meaningful (e.g. highlighting) or whose user-supplied content is empty (e.g. an assessing annotation saved without comment text). Shape matches Annotation.body."
        ),
    ] = None


class MatchSearchResult(WireModel, frozen=True):
    """
    Search results payload emitted on match:search-results SSE channel.
    """

    reference_id: Annotated[AnnotationId, Field(alias="referenceId")]
    response: Annotated[list[ScoredResource], Field(description="The scored candidates, best first.")]


class MatchResourcesResponse(WireModel, frozen=True):
    """
    One page of the resources a text search found, and which kind of answer it is.
    """

    resources: list[ResourceDescriptor]
    total: float
    offset: float
    limit: float
    match_kind: Annotated[
        Literal["lexical", "semantic"],
        Field(
            alias="matchKind",
            description="What kind of answer this is: 'lexical' — the resources matched the query text; 'semantic' — no lexical match existed, and these resources discuss the query per the vector index. Required so every producer labels its answer; a UI can render semantic results as a different kind of page ('no title matches, but these documents discuss it').",
        ),
    ]


class MatchResourcesResult(WireModel, frozen=True):
    """
    Result of searching resources by text
    """

    response: MatchResourcesResponse


type JobStoredProgress = Annotated[
    JobProgress | dict[str, JsonValue],
    Field(
        description="A running job's progress as the dispatcher stores it: the last JobProgress its worker reported with `job:report-progress`, or an empty object before the first report."
    ),
]


class JobRunning(WireModel, frozen=True, extra="forbid"):
    """
    A job a worker has claimed and not yet concluded.
    """

    status: Literal["running"]
    metadata: JobMetadata
    params: JobParams
    started_at: Annotated[
        str,
        Field(
            alias="startedAt",
            description="When the claim that holds it was made, as an ISO 8601 timestamp.",
        ),
    ]
    progress: JobStoredProgress


type Job = Annotated[
    JobPending | JobRunning | JobComplete | JobFailed | JobCancelled,
    Field(
        description="A job as the dispatcher holds it. Its `status` decides which timestamps and outcome fields it carries. It is what a claim returns (`job:claimed`, always `running`) and what the queue stores, inside a JobRecord.",
        discriminator="status",
    ),
]


class JobRecord(WireModel, frozen=True, extra="forbid"):
    """
    One job as the queue stores it: the job, and when it last showed life. The dead-worker sweep reads `lastProgressAt`: a running job whose worker has reported nothing for the configured interval is presumed dead. Where the queue keeps these records is the job storage layout, specs/src/jobs/storage.json.
    """

    job: Job
    last_progress_at: Annotated[
        str,
        Field(
            alias="lastProgressAt",
            description="When the job was created, claimed, checkpointed or last reported progress, as an ISO 8601 timestamp.",
        ),
    ]


class JobClaimedResult(WireModel, frozen=True, extra="forbid"):
    """
    The reply to a successful `job:claim`: the claimed job, now running under the claimant.
    """

    response: JobRunning


class ArchivistConfig(WireModel, frozen=True, extra="forbid"):
    """
    Everything the Archivist reads at boot, resolved: no ${VAR} is left in it and nothing in it is defaulted by the Archivist. The launcher writes it for the Archivist it starts, from the environment the knowledge base's config selects, and the Archivist reads it from the path its `--config` flag names (its image passes `/etc/semiont/archivist.json`). Started without `--config`, or with a path that names no file, the Archivist refuses to start and says which. No secret is a value here. What the knowledge base says of itself is not here either: its name, its `[site] domain` and its `[git] sync` are read from the committed `.semiont/config` of the tree at `root`. The Archivist's other inputs are the environment variables specs/src/service-environment/variables.json lists for it. A document that does not validate is refused at boot, naming each failing field.
    """

    gateway_url: Annotated[
        str,
        Field(
            alias="gatewayUrl",
            description="The URL the Archivist reaches the gateway at: its only route to the bus.",
            min_length=1,
        ),
    ]
    identity: Annotated[
        Identity2,
        Field(
            description="The issuer the Archivist's service account signs in at, and whose tokens it admits callers of its HTTP surface by."
        ),
    ]
    root: Annotated[
        str,
        Field(
            description="The knowledge base's working tree: the directory holding `.semiont/`. The event log, the content and the committed config are under it.",
            min_length=1,
        ),
    ]
    state_home: Annotated[
        str,
        Field(
            alias="stateHome",
            description="The state volume. The Archivist keeps the knowledge base's views and projections under `semiont/<name>` in it, where the name is the knowledge base's.",
            min_length=1,
        ),
    ]
    anchored_text_dir: Annotated[
        str,
        Field(
            alias="anchoredTextDir",
            description="The anchored-text store the Smelter writes and the Archivist reads.",
            min_length=1,
        ),
    ]
    roster: ArchivistRoster
    port: Annotated[
        int,
        Field(
            description="The port the Archivist's HTTP surface answers on, `/health` included.",
            ge=1,
            le=65535,
        ),
    ]
    skip_rebuild: Annotated[
        bool,
        Field(
            alias="skipRebuild",
            description="Whether the Archivist serves the views it finds at boot instead of rebuilding them from the event log first.",
        ),
    ]
    staging: Annotated[
        Staging,
        Field(
            description="The bounds on how far the staging driver may run behind the working tree, in milliseconds. A knowledge base that does not sync git stages nothing, and reads neither."
        ),
    ]
    log_level: Annotated[LogLevel, Field(alias="logLevel")]
    log_format: Annotated[LogFormat, Field(alias="logFormat")]


class Annotation(WireModel, frozen=True):
    context: Annotated[
        Literal["http://www.w3.org/ns/anno.jsonld"],
        Field(alias="@context", description="W3C Web Annotation JSON-LD context"),
    ]
    type: Annotated[Literal["Annotation"], Field(description="W3C Annotation type")]
    id: AnnotationId
    motivation: Motivation
    target: Annotated[
        ResourceId | AnnotationTarget,
        Field(
            description="W3C Web Annotation target - can be a simple IRI string (entire resource) or an object with source and optional selector (fragment)"
        ),
    ]
    body: Annotated[
        AnnotationBodies | None,
        Field(
            description="W3C Web Annotation body. Optional per the W3C spec — annotations whose motivation alone is meaningful (highlighting) legitimately omit it. Present values are either a single body or a non-empty array of bodies; there is no empty array."
        ),
    ] = None
    creator: Annotated[
        Agent | None,
        Field(
            description="Web Annotation creator — who requested the annotation. DERIVED by the knowledge base at write time, never accepted from an emitter (a payload carrying it is refused): the verified emitter of the write, or, when the write cites a job, the verified emitter of the job:create that produced it. A Person for human-requested work; a Software peer for autonomous-agent work."
        ),
    ] = None
    created: Annotated[
        str,
        Field(
            description="When the annotation was MADE — the authoring moment, carried from the event that created it. Not when a projection happened to write it: a store that rebuilds from the log must preserve this value, never restamp it."
        ),
    ]
    modified: str | None = None
    generator: Annotated[
        Agent | Generator | None,
        Field(
            description="Web Annotation generator — the Software peer that produced the annotation, when software did. Absent for a person's own annotation. An emitter may supply it to carry the model's parameters, but its identity must be the emitter's own: the knowledge base refuses a generator naming anyone else, and supplies it from the verified emitter when omitted. One producer per write — a write carrying the array form is refused."
        ),
    ] = None
    was_attributed_to: Annotated[
        Agent | WasAttributedTo | None,
        Field(
            alias="wasAttributedTo",
            description="PROV-O wasAttributedTo — every party responsible for this annotation, DERIVED by the knowledge base from `creator` and the verified executor of the write: `[creator, generator]` when one agent requested the work and software produced it; collapsed to the one agent when requester and producer are the same. Never accepted from an emitter.",
        ),
    ] = None


class AnnotationAddedPayload(WireModel, frozen=True):
    """
    Payload for mark:added domain event
    """

    annotation: Annotation
    content_checksum: Annotated[
        str | None,
        Field(
            alias="contentChecksum",
            description="SHA-256 of resource content at annotation time",
        ),
    ] = None


class AnnotationContextResponse(WireModel, frozen=True):
    annotation: Annotation
    context: Context
    resource: ResourceDescriptor


class BrowseAnchoredTextResult(WireModel, frozen=True):
    """
    A resource's coordinate map, a stored decline, or a named reason there is none. Never null: a bare null would cover four different facts — barrier expired, settled-skipped, no content identity, fold disposed — two of which a caller should retry and two of which it should not.
    """

    response: AnchoredTextAnswer


class BrowseResourcesResult(WireModel, frozen=True):
    """
    Result of browsing resources
    """

    response: ListResourcesResponse


class EnrichedResourceEvent(StoredEventResponse, frozen=True):
    """
    Wire format for persisted events delivered over the bus SSE stream (GET /bus/subscribe). Extends StoredEventResponse with optional enrichment fields the EventStore populates from the materialized view at publish time (persistence → view → enrich → notification). Subscribers read the enrichment fields directly to update local caches without an additional fetch.
    """

    annotation: Annotated[
        Annotation | None,
        Field(
            description="Populated for events that mutate an annotation (mark:added, mark:body-updated, mark:removed). Carries the post-materialization annotation as it exists in the view, so subscribers can update local caches in-place without refetching. Absent for events that don't touch annotations."
        ),
    ] = None


class Focus(WireModel, frozen=True):
    """
    Annotation-anchored focus.
    """

    kind: Literal["annotation"]
    annotation: Annotated[Annotation, Field(description="The annotation this context was gathered for")]
    source_resource: Annotated[
        ResourceDescriptor,
        Field(alias="sourceResource", description="The resource containing the annotation"),
    ]
    selected: Annotated[Selected | None, Field(description="Text context around the annotation target")] = None
    user_hint: Annotated[
        str | None,
        Field(
            alias="userHint",
            description="User-provided hint to supplement or replace the selected text for search and generation",
        ),
    ] = None
    target_resource: Annotated[
        ResourceDescriptor | None,
        Field(
            alias="targetResource",
            description="The resource the annotation links to, if it is a resolved reference. Dormant capability — produced/exposed but not yet consumed.",
        ),
    ] = None
    target_context: Annotated[
        TargetContext | None,
        Field(
            alias="targetContext",
            description="Context about the annotation's link target. Dormant — produced/exposed but not yet consumed.",
        ),
    ] = None


class GetAnnotationResponse(WireModel, frozen=True):
    annotation: Annotation
    resource: Annotated[ResourceDescriptor | None, Field(...)]
    resolved_resource: Annotated[ResourceDescriptor | None, Field(alias="resolvedResource")]


class GetAnnotationsResponse(WireModel, frozen=True):
    annotations: list[Annotation]
    total: Annotated[float, Field(description="Total number of annotations")]
    motivation: Annotated[Motivation | None, Field(description="Motivation filter applied (if any)")] = None


class GetResourceResponse(WireModel, frozen=True):
    resource: ResourceDescriptor
    annotations: Annotated[
        list[Annotation],
        Field(description="All annotations for the resource (highlights, references, assessments, etc.)"),
    ]
    entity_references: Annotated[
        list[Annotation],
        Field(
            alias="entityReferences",
            description="Annotations that reference this resource from other resources",
        ),
    ]


class GraphAnnotationNode(WireModel, frozen=True):
    """
    An annotation's graph presence. The node IS the annotation, so the full W3C object is required — selectors and body included, which is what lets a client place context annotations without a second fetch. Citations ride here too: an inbound reference is its linking annotation, anchored by an `annotation-of` edge to the resource it lives on and a `cites` edge to the focal resource.
    """

    id: Annotated[
        AnnotationId,
        Field(description="The AnnotationId — the same value as annotation.id"),
    ]
    type: Literal["annotation"]
    label: Annotated[str, Field(description="The annotation's motivation, as a display label")]
    entity_types: Annotated[
        list[str] | None,
        Field(alias="entityTypes", description="Entity types carried by the annotation"),
    ] = None
    annotation: Annotation
    metadata: dict[str, JsonValue] | None = None


class JobStatusResponse(WireModel, frozen=True):
    job_id: Annotated[JobId, Field(alias="jobId")]
    type: JobType
    status: Literal["pending", "running", "complete", "failed", "cancelled"]
    user_id: Annotated[UserId, Field(alias="userId")]
    created: str
    started_at: Annotated[str | None, Field(alias="startedAt")] = None
    completed_at: Annotated[str | None, Field(alias="completedAt")] = None
    error: str | None = None
    progress: JobStoredProgress | None = None
    result: JobStoredResult | None = None


class JobStatusResult(WireModel, frozen=True):
    """
    Result of a job status request
    """

    response: JobStatusResponse


type Nodes = Annotated[GraphResourceNode | GraphAnnotationNode, Field(discriminator="type")]


class KnowledgeGraph(WireModel, frozen=True):
    """
    Knowledge graph gathered for an LLM context — a shared backbone in which resources AND annotations are typed nodes, connected by typed (optionally bidirectional) edges. Flattened views the matcher/generation read (connections, citedBy, siblings) are derived from these nodes/edges.
    """

    nodes: list[Nodes]
    edges: list[Edge]


class MarkCreateCommand(WireModel, frozen=True):
    """
    Bus command to create an annotation on a resource. The annotation carries body, target and, when software wrote it, a generator naming the emitter itself; `creator` and `wasAttributedTo` are derived by the knowledge base from the verified emitter, and a payload carrying `creator` is refused.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    annotation: Annotation
    resource_id: Annotated[ResourceId, Field(alias="resourceId")]


class MarkCommitCommand(WireModel, frozen=True):
    """
    Bus command to persist a detection unit's annotations as one acknowledged batch. Unlike mark:create, which is fire-and-forget and resolves when the bus accepts it, this command is answered only after every annotation is in the event log — so a worker can gate unit completion on durability rather than on emission. The batch is the unit: a partial commit is reported as a failure, and the worker retries the whole unit, which is safe because annotation ids are deterministic: content-addressed, so re-emitting one is a no-op.
    """

    user_id: Annotated[
        UserId | None,
        Field(
            alias="_userId",
            description="Authenticated user's DID, injected by the /bus/emit gateway. Clients do not set this.",
        ),
    ] = None
    roles: Annotated[
        list[str] | None,
        Field(
            alias="_roles",
            description="The emitter's capabilities (the token's `roles`), injected by the /bus/emit gateway. Clients do not set this. An emitter carrying the worker role must cite the job this batch fulfils in `jobId`; the Stower refuses the batch otherwise.",
        ),
    ] = None
    job_id: Annotated[
        JobId | None,
        Field(
            alias="jobId",
            description="The job this batch fulfils. Required when the emitter carries the worker role; absent for self-initiated work (a person, or an agent acting on its own). The knowledge base derives who requested these annotations from the cited job's own events — the emitter never says who the work was for.",
        ),
    ] = None
    resource_id: Annotated[
        ResourceId,
        Field(
            alias="resourceId",
            description="Resource every annotation in this batch targets.",
        ),
    ]
    annotations: Annotated[
        list[Annotation],
        Field(
            description="The unit's annotations, already built with deterministic ids. Re-committing an identical batch is a no-op rather than a duplicate."
        ),
    ]


class ResourceAnnotations(WireModel, frozen=True, extra="forbid"):
    """
    The annotations on one resource, as its materialized view holds them.
    """

    resource_id: Annotated[ResourceId, Field(alias="resourceId")]
    annotations: Annotated[
        list[Annotation],
        Field(
            description="Each annotation as the `mark:added` event that recorded it carried it, with the body changes recorded since applied. In the order they were first recorded."
        ),
    ]
    version: Annotated[
        int,
        Field(description="How many of the resource's events the view has applied.", ge=0),
    ]
    updated_at: Annotated[
        str,
        Field(
            alias="updatedAt",
            description="The timestamp of the last event applied; the empty string before any.",
        ),
    ]


class ResourceView(WireModel, frozen=True, extra="forbid"):
    """
    A resource's materialized view: the file the Archivist writes at `resources/<ab>/<cd>/<resourceId>.json` under the knowledge base's state directory, and every reader of that file reads. It is what the resource's events add up to, and is rebuilt from the event log whenever it is missing. Written as JSON indented by two spaces, by writing a sibling temporary file and renaming it onto the path, so a reader sees a whole document or none.
    """

    resource: ResourceDescriptor
    annotations: ResourceAnnotations
    last_sequence: Annotated[
        int,
        Field(
            alias="lastSequence",
            description="The sequence number of the last event applied. A graph read that follows a write waits for the graph projection to reach it.",
            ge=1,
        ),
    ]


class BrowseAnnotationResult(WireModel, frozen=True):
    """
    Result of browsing a single annotation
    """

    response: GetAnnotationResponse


class BrowseAnnotationsResult(WireModel, frozen=True):
    """
    Result of browsing annotations for a resource
    """

    response: GetAnnotationsResponse


class BrowseResourceResult(WireModel, frozen=True):
    """
    Result of browsing a single resource
    """

    response: GetResourceResponse


class GatheredContext(WireModel, frozen=True):
    """
    Context gathered for a gather.* call — consumed by yield.* (generation) and the matcher. A shared base (graph, semanticContext, metadata, inferredRelationshipSummary) plus a discriminated `focus` that names the anchor: an annotation or a whole resource.
    """

    focus: Annotated[Focus | Focus1, Field(description="The gather anchor. Discriminated on `kind`.")]
    graph: Annotated[
        KnowledgeGraph,
        Field(
            description="Knowledge graph backbone — resources AND annotations as typed nodes. The flattened views (connections, citedBy, siblings) are derived from this."
        ),
    ]
    semantic_context: Annotated[
        SemanticContext | None,
        Field(
            alias="semanticContext",
            description="Semantically similar passages from across the knowledge base, found via vector search",
        ),
    ] = None
    metadata: Annotated[
        Metadata,
        Field(description="Context metadata about the focal anchor and its source"),
    ]
    inferred_relationship_summary: Annotated[
        str | None,
        Field(
            alias="inferredRelationshipSummary",
            description="LLM-generated summary of the focal anchor's relationships in the knowledge graph",
        ),
    ] = None


class GenerationJobParams(WireModel, frozen=True):
    """
    Params bag for `job:create` with `jobType: 'generation'` — exactly the shape yield.fromContext(context, options) takes: options + the gathered context. The job's ids are DERIVED from context.focus at the dispatcher (resource focus → focus.resource; annotation focus → focus.sourceResource, with the worker auto-binding to focus.annotation); a caller-supplied referenceId is rejected. Carried inside JobCreateCommand.params; this schema is the generation shape's contract, including its requiredness.
    """

    title: Annotated[
        str,
        Field(
            description="Title of the generated resource. Non-empty: the dispatcher and worker both reject an empty title via isGenerationJobParams. NOTE minLength is documentation here — JobCreateCommand.params is additionalProperties:true, so /bus/emit's generated validator never sees this field.",
            min_length=1,
        ),
    ]
    storage_uri: Annotated[
        str,
        Field(
            alias="storageUri",
            description="Storage URI for the generated resource's content — AUTHORITATIVE: the worker writes exactly here and never derives a location from the title. Non-empty, and there is no fallback; the dispatcher and worker both reject an empty value via isGenerationJobParams. NOTE minLength is documentation here — JobCreateCommand.params is additionalProperties:true, so /bus/emit's generated validator never sees this field.",
            min_length=1,
        ),
    ]
    context: Annotated[
        GatheredContext,
        Field(
            description="The gathered context that grounds the generation. Its `focus` names the anchor: the DISPATCHER derives the job's resourceId from it (resource focus → focus.resource; annotation focus → focus.sourceResource, with the worker auto-binding to focus.annotation) and REJECTS a caller-supplied id — the context is authoritative. Under `cite`, the ids its embedding carries are the only valid citation targets."
        ),
    ]
    prompt: Annotated[
        str | None,
        Field(description="Refining instruction, composed with `task` (task = what, prompt = how)."),
    ] = None
    entity_types: Annotated[
        list[str] | None,
        Field(
            alias="entityTypes",
            description="Entity-type tags to stamp on the synthesized resource. Used both as a prompt bias for the generation worker and as the `entityTypes` set on the resulting resource.",
        ),
    ] = None
    language: Annotated[
        str | None,
        Field(
            description="Annotation/resource body locale — language the generated resource is written in (typically the user's UI locale). BCP-47."
        ),
    ] = None
    source_language: Annotated[
        str | None,
        Field(
            alias="sourceLanguage",
            description="Source-resource locale — language of the resource being referenced, used in the prompt so the LLM understands embedded source-context snippets when source ≠ target language. BCP-47.",
        ),
    ] = None
    temperature: Annotated[float | None, Field(description="Sampling temperature forwarded to the model.")] = None
    max_tokens: Annotated[
        float | None,
        Field(
            alias="maxTokens",
            description="Output token budget forwarded to the model. Length never determines structure.",
        ),
    ] = None
    output_media_type: Annotated[
        SupportedMediaType | None,
        Field(
            alias="outputMediaType",
            description="Requested media type of the generated resource's content. Default `text/markdown` at the worker, which validates it against its supported output set and FAILS the job for anything it can't write — not a silent fallback.",
        ),
    ] = None
    task: Annotated[
        str | None,
        Field(
            description="What the model is asked to produce — the prompt's framing verb. Canonical values ('resource', 'answer', 'summary') map to the worker's tested framings; any other string is used VERBATIM as the framing instruction (loud degrade: the worker warns, never silently falls back). Unset ⇒ 'resource' (article framing)."
        ),
    ] = None
    structure: Annotated[
        str | None,
        Field(
            description="How the output is internally segmented — shape for text-bearing media, subordinate to `outputMediaType` (never its peer). Canonical values: 'prose' (flowing paragraphs), 'sections' (titled sections + title), 'chat' (speaker-labeled turns); any other string becomes a freeform \"organize as: …\" directive (loud degrade). Unset ⇒ NO structure directive at all — the task framing and the model determine shape."
        ),
    ] = None
    cite: Annotated[
        bool | None,
        Field(
            description="Ask the model to cite: emit [[<id>]] transport tokens after each claim, using the ids the context embedding provides. The worker validates each id against the embedded context (unknown ids are dropped loudly), strips the tokens from the stored content, and mints W3C linking annotations on the derived resource."
        ),
    ] = None


class MatchSearchRequest(WireModel, frozen=True):
    """
    Request payload sent on the match:search-request bus channel to find candidate matches.
    """

    resource_id: Annotated[
        ResourceId,
        Field(
            alias="resourceId",
            description="Resource ID the reference annotation belongs to. Used to scope result events on the EventBus so the events-stream delivers them to participants viewing this resource.",
        ),
    ]
    reference_id: Annotated[
        AnnotationId,
        Field(
            alias="referenceId",
            description="Annotation ID of the reference to search candidates for",
        ),
    ]
    context: Annotated[
        GatheredContext,
        Field(description="Gathered context for the reference annotation"),
    ]
    limit: Annotated[int | None, Field(description="Maximum number of candidate results to return")] = None
    use_semantic_scoring: Annotated[
        bool | None,
        Field(
            alias="useSemanticScoring",
            description="Enable semantic similarity scoring in addition to keyword matching",
        ),
    ] = None


class GatherAnnotationComplete(WireModel, frozen=True):
    """
    Completion payload emitted on the gather:annotation-complete bus channel when annotation context gathering finishes.
    """

    annotation_id: Annotated[
        AnnotationId,
        Field(
            alias="annotationId",
            description="Branded AnnotationId of the annotation whose context was gathered",
        ),
    ]
    response: Annotated[
        GatheredContext,
        Field(description="The gathered annotation context (unified GatheredContext, focus.kind:'annotation')"),
    ]


class GatherResourceComplete(WireModel, frozen=True):
    """
    Completion payload emitted on the gather:resource-complete bus channel when resource context gathering finishes.
    """

    resource_id: Annotated[
        ResourceId,
        Field(
            alias="resourceId",
            description="Branded ResourceId of the resource whose context was gathered",
        ),
    ]
    response: Annotated[
        GatheredContext,
        Field(description="The gathered resource context (unified GatheredContext, focus.kind:'resource')"),
    ]
