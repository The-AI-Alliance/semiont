# Generated from specs/src/bus/registry.json; do not edit.
# Regenerate: node scripts/bus/generate-python.mjs

"""Every request of the bus, with the two channels it is answered on.

An operation is named for its request channel. Its type says what is sent and
what a reply carries, so a request is refused another operation's payload, and
its answer is typed, by a type checker.
"""

from collections.abc import Mapping
from types import MappingProxyType
from typing import Final

from semiont import channels
from semiont.channel import AnyOperation, Operation

__all__ = [
    "OPERATIONS",
    "BIND_UPDATE_BODY",
    "BROWSE_AGENTS_REQUESTED",
    "BROWSE_ANCHORED_TEXT_REQUESTED",
    "BROWSE_ANNOTATIONS_REQUESTED",
    "BROWSE_ANNOTATION_CONTEXT_REQUESTED",
    "BROWSE_ANNOTATION_HISTORY_REQUESTED",
    "BROWSE_ANNOTATION_REQUESTED",
    "BROWSE_DIRECTORY_REQUESTED",
    "BROWSE_ENTITY_TYPES_REQUESTED",
    "BROWSE_EVENTS_REQUESTED",
    "BROWSE_KB_REQUESTED",
    "BROWSE_RESOURCES_REQUESTED",
    "BROWSE_RESOURCE_REQUESTED",
    "BROWSE_TAG_SCHEMAS_REQUESTED",
    "FRAME_ADD_ENTITY_TYPE",
    "FRAME_ADD_TAG_SCHEMA",
    "GATHER_LIMITS_REQUESTED",
    "GATHER_REFERENCED_BY_REQUESTED",
    "GATHER_REQUESTED",
    "GATHER_RESOURCE_REQUESTED",
    "GATHER_SUMMARY_REQUESTED",
    "JOB_CANCEL_REQUESTED",
    "JOB_CLAIM",
    "JOB_CREATE",
    "JOB_LIMITS_REQUESTED",
    "JOB_STATUS_REQUESTED",
    "MARK_ARCHIVE",
    "MARK_COMMIT",
    "MARK_CREATE_REQUEST",
    "MARK_DELETE",
    "MARK_UNARCHIVE",
    "MARK_UPDATE_ENTITY_TYPES",
    "MATCH_LIMITS_REQUESTED",
    "MATCH_RESOURCES_REQUESTED",
    "MATCH_SEARCH_REQUESTED",
    "SMELT_REBUILD_ANCHORS",
    "WEAVE_REBUILD",
    "YIELD_CLONE_CREATE",
    "YIELD_CLONE_PERSIST",
    "YIELD_CLONE_RESOURCE_REQUESTED",
    "YIELD_CLONE_TOKEN_REQUESTED",
    "YIELD_CREATE",
    "YIELD_UPDATE",
]

BIND_UPDATE_BODY: Final = Operation(
    request=channels.BIND_UPDATE_BODY,
    result=channels.BIND_BODY_UPDATED,
    failure=channels.BIND_BODY_UPDATE_FAILED,
)
BROWSE_RESOURCE_REQUESTED: Final = Operation(
    request=channels.BROWSE_RESOURCE_REQUESTED,
    result=channels.BROWSE_RESOURCE_RESULT,
    failure=channels.BROWSE_RESOURCE_FAILED,
)
BROWSE_ANCHORED_TEXT_REQUESTED: Final = Operation(
    request=channels.BROWSE_ANCHORED_TEXT_REQUESTED,
    result=channels.BROWSE_ANCHORED_TEXT_RESULT,
    failure=channels.BROWSE_ANCHORED_TEXT_FAILED,
)
BROWSE_RESOURCES_REQUESTED: Final = Operation(
    request=channels.BROWSE_RESOURCES_REQUESTED,
    result=channels.BROWSE_RESOURCES_RESULT,
    failure=channels.BROWSE_RESOURCES_FAILED,
)
BROWSE_ANNOTATION_REQUESTED: Final = Operation(
    request=channels.BROWSE_ANNOTATION_REQUESTED,
    result=channels.BROWSE_ANNOTATION_RESULT,
    failure=channels.BROWSE_ANNOTATION_FAILED,
)
BROWSE_ANNOTATIONS_REQUESTED: Final = Operation(
    request=channels.BROWSE_ANNOTATIONS_REQUESTED,
    result=channels.BROWSE_ANNOTATIONS_RESULT,
    failure=channels.BROWSE_ANNOTATIONS_FAILED,
)
BROWSE_ANNOTATION_HISTORY_REQUESTED: Final = Operation(
    request=channels.BROWSE_ANNOTATION_HISTORY_REQUESTED,
    result=channels.BROWSE_ANNOTATION_HISTORY_RESULT,
    failure=channels.BROWSE_ANNOTATION_HISTORY_FAILED,
)
BROWSE_EVENTS_REQUESTED: Final = Operation(
    request=channels.BROWSE_EVENTS_REQUESTED,
    result=channels.BROWSE_EVENTS_RESULT,
    failure=channels.BROWSE_EVENTS_FAILED,
)
BROWSE_ENTITY_TYPES_REQUESTED: Final = Operation(
    request=channels.BROWSE_ENTITY_TYPES_REQUESTED,
    result=channels.BROWSE_ENTITY_TYPES_RESULT,
    failure=channels.BROWSE_ENTITY_TYPES_FAILED,
)
BROWSE_TAG_SCHEMAS_REQUESTED: Final = Operation(
    request=channels.BROWSE_TAG_SCHEMAS_REQUESTED,
    result=channels.BROWSE_TAG_SCHEMAS_RESULT,
    failure=channels.BROWSE_TAG_SCHEMAS_FAILED,
)
BROWSE_AGENTS_REQUESTED: Final = Operation(
    request=channels.BROWSE_AGENTS_REQUESTED,
    result=channels.BROWSE_AGENTS_RESULT,
    failure=channels.BROWSE_AGENTS_FAILED,
)
BROWSE_KB_REQUESTED: Final = Operation(
    request=channels.BROWSE_KB_REQUESTED,
    result=channels.BROWSE_KB_RESULT,
    failure=channels.BROWSE_KB_FAILED,
)
BROWSE_DIRECTORY_REQUESTED: Final = Operation(
    request=channels.BROWSE_DIRECTORY_REQUESTED,
    result=channels.BROWSE_DIRECTORY_RESULT,
    failure=channels.BROWSE_DIRECTORY_FAILED,
)
BROWSE_ANNOTATION_CONTEXT_REQUESTED: Final = Operation(
    request=channels.BROWSE_ANNOTATION_CONTEXT_REQUESTED,
    result=channels.BROWSE_ANNOTATION_CONTEXT_RESULT,
    failure=channels.BROWSE_ANNOTATION_CONTEXT_FAILED,
)
FRAME_ADD_ENTITY_TYPE: Final = Operation(
    request=channels.FRAME_ADD_ENTITY_TYPE,
    result=channels.FRAME_ENTITY_TYPE_ADD_OK,
    failure=channels.FRAME_ENTITY_TYPE_ADD_FAILED,
)
FRAME_ADD_TAG_SCHEMA: Final = Operation(
    request=channels.FRAME_ADD_TAG_SCHEMA,
    result=channels.FRAME_TAG_SCHEMA_ADD_OK,
    failure=channels.FRAME_TAG_SCHEMA_ADD_FAILED,
)
GATHER_REQUESTED: Final = Operation(
    request=channels.GATHER_REQUESTED,
    result=channels.GATHER_COMPLETE,
    failure=channels.GATHER_FAILED,
)
GATHER_RESOURCE_REQUESTED: Final = Operation(
    request=channels.GATHER_RESOURCE_REQUESTED,
    result=channels.GATHER_RESOURCE_COMPLETE,
    failure=channels.GATHER_RESOURCE_FAILED,
)
GATHER_SUMMARY_REQUESTED: Final = Operation(
    request=channels.GATHER_SUMMARY_REQUESTED,
    result=channels.GATHER_SUMMARY_RESULT,
    failure=channels.GATHER_SUMMARY_FAILED,
)
GATHER_REFERENCED_BY_REQUESTED: Final = Operation(
    request=channels.GATHER_REFERENCED_BY_REQUESTED,
    result=channels.GATHER_REFERENCED_BY_RESULT,
    failure=channels.GATHER_REFERENCED_BY_FAILED,
)
GATHER_LIMITS_REQUESTED: Final = Operation(
    request=channels.GATHER_LIMITS_REQUESTED,
    result=channels.GATHER_LIMITS_RESULT,
    failure=channels.GATHER_LIMITS_FAILED,
)
JOB_CREATE: Final = Operation(
    request=channels.JOB_CREATE,
    result=channels.JOB_CREATED,
    failure=channels.JOB_CREATE_FAILED,
)
JOB_STATUS_REQUESTED: Final = Operation(
    request=channels.JOB_STATUS_REQUESTED,
    result=channels.JOB_STATUS_RESULT,
    failure=channels.JOB_STATUS_FAILED,
)
JOB_LIMITS_REQUESTED: Final = Operation(
    request=channels.JOB_LIMITS_REQUESTED,
    result=channels.JOB_LIMITS_RESULT,
    failure=channels.JOB_LIMITS_FAILED,
)
JOB_CANCEL_REQUESTED: Final = Operation(
    request=channels.JOB_CANCEL_REQUESTED,
    result=channels.JOB_CANCEL_OK,
    failure=channels.JOB_CANCEL_FAILED,
)
JOB_CLAIM: Final = Operation(
    request=channels.JOB_CLAIM,
    result=channels.JOB_CLAIMED,
    failure=channels.JOB_CLAIM_FAILED,
)
MARK_CREATE_REQUEST: Final = Operation(
    request=channels.MARK_CREATE_REQUEST,
    result=channels.MARK_CREATE_OK,
    failure=channels.MARK_CREATE_FAILED,
)
MARK_COMMIT: Final = Operation(
    request=channels.MARK_COMMIT,
    result=channels.MARK_COMMIT_OK,
    failure=channels.MARK_COMMIT_FAILED,
)
MARK_DELETE: Final = Operation(
    request=channels.MARK_DELETE,
    result=channels.MARK_DELETE_OK,
    failure=channels.MARK_DELETE_FAILED,
)
MARK_ARCHIVE: Final = Operation(
    request=channels.MARK_ARCHIVE,
    result=channels.MARK_ARCHIVE_OK,
    failure=channels.MARK_ARCHIVE_FAILED,
)
MARK_UNARCHIVE: Final = Operation(
    request=channels.MARK_UNARCHIVE,
    result=channels.MARK_UNARCHIVE_OK,
    failure=channels.MARK_UNARCHIVE_FAILED,
)
MARK_UPDATE_ENTITY_TYPES: Final = Operation(
    request=channels.MARK_UPDATE_ENTITY_TYPES,
    result=channels.MARK_UPDATE_ENTITY_TYPES_OK,
    failure=channels.MARK_UPDATE_ENTITY_TYPES_FAILED,
)
MATCH_SEARCH_REQUESTED: Final = Operation(
    request=channels.MATCH_SEARCH_REQUESTED,
    result=channels.MATCH_SEARCH_RESULTS,
    failure=channels.MATCH_SEARCH_FAILED,
)
MATCH_RESOURCES_REQUESTED: Final = Operation(
    request=channels.MATCH_RESOURCES_REQUESTED,
    result=channels.MATCH_RESOURCES_RESULT,
    failure=channels.MATCH_RESOURCES_FAILED,
)
MATCH_LIMITS_REQUESTED: Final = Operation(
    request=channels.MATCH_LIMITS_REQUESTED,
    result=channels.MATCH_LIMITS_RESULT,
    failure=channels.MATCH_LIMITS_FAILED,
)
WEAVE_REBUILD: Final = Operation(
    request=channels.WEAVE_REBUILD,
    result=channels.WEAVE_REBUILD_OK,
    failure=channels.WEAVE_REBUILD_FAILED,
)
SMELT_REBUILD_ANCHORS: Final = Operation(
    request=channels.SMELT_REBUILD_ANCHORS,
    result=channels.SMELT_REBUILD_ANCHORS_OK,
    failure=channels.SMELT_REBUILD_ANCHORS_FAILED,
)
YIELD_CREATE: Final = Operation(
    request=channels.YIELD_CREATE,
    result=channels.YIELD_CREATE_OK,
    failure=channels.YIELD_CREATE_FAILED,
)
YIELD_CLONE_PERSIST: Final = Operation(
    request=channels.YIELD_CLONE_PERSIST,
    result=channels.YIELD_CLONE_PERSIST_OK,
    failure=channels.YIELD_CLONE_PERSIST_FAILED,
)
YIELD_UPDATE: Final = Operation(
    request=channels.YIELD_UPDATE,
    result=channels.YIELD_UPDATE_OK,
    failure=channels.YIELD_UPDATE_FAILED,
)
YIELD_CLONE_CREATE: Final = Operation(
    request=channels.YIELD_CLONE_CREATE,
    result=channels.YIELD_CLONE_CREATED,
    failure=channels.YIELD_CLONE_CREATE_FAILED,
)
YIELD_CLONE_RESOURCE_REQUESTED: Final = Operation(
    request=channels.YIELD_CLONE_RESOURCE_REQUESTED,
    result=channels.YIELD_CLONE_RESOURCE_RESULT,
    failure=channels.YIELD_CLONE_RESOURCE_FAILED,
)
YIELD_CLONE_TOKEN_REQUESTED: Final = Operation(
    request=channels.YIELD_CLONE_TOKEN_REQUESTED,
    result=channels.YIELD_CLONE_TOKEN_GENERATED,
    failure=channels.YIELD_CLONE_TOKEN_FAILED,
)

# Every operation, by the name of its request channel: for code that is given a name and not a constant.
OPERATIONS: Final[Mapping[str, AnyOperation]] = MappingProxyType(
    {
        "bind:update-body": BIND_UPDATE_BODY,
        "browse:resource-requested": BROWSE_RESOURCE_REQUESTED,
        "browse:anchored-text-requested": BROWSE_ANCHORED_TEXT_REQUESTED,
        "browse:resources-requested": BROWSE_RESOURCES_REQUESTED,
        "browse:annotation-requested": BROWSE_ANNOTATION_REQUESTED,
        "browse:annotations-requested": BROWSE_ANNOTATIONS_REQUESTED,
        "browse:annotation-history-requested": BROWSE_ANNOTATION_HISTORY_REQUESTED,
        "browse:events-requested": BROWSE_EVENTS_REQUESTED,
        "browse:entity-types-requested": BROWSE_ENTITY_TYPES_REQUESTED,
        "browse:tag-schemas-requested": BROWSE_TAG_SCHEMAS_REQUESTED,
        "browse:agents-requested": BROWSE_AGENTS_REQUESTED,
        "browse:kb-requested": BROWSE_KB_REQUESTED,
        "browse:directory-requested": BROWSE_DIRECTORY_REQUESTED,
        "browse:annotation-context-requested": BROWSE_ANNOTATION_CONTEXT_REQUESTED,
        "frame:add-entity-type": FRAME_ADD_ENTITY_TYPE,
        "frame:add-tag-schema": FRAME_ADD_TAG_SCHEMA,
        "gather:requested": GATHER_REQUESTED,
        "gather:resource-requested": GATHER_RESOURCE_REQUESTED,
        "gather:summary-requested": GATHER_SUMMARY_REQUESTED,
        "gather:referenced-by-requested": GATHER_REFERENCED_BY_REQUESTED,
        "gather:limits-requested": GATHER_LIMITS_REQUESTED,
        "job:create": JOB_CREATE,
        "job:status-requested": JOB_STATUS_REQUESTED,
        "job:limits-requested": JOB_LIMITS_REQUESTED,
        "job:cancel-requested": JOB_CANCEL_REQUESTED,
        "job:claim": JOB_CLAIM,
        "mark:create-request": MARK_CREATE_REQUEST,
        "mark:commit": MARK_COMMIT,
        "mark:delete": MARK_DELETE,
        "mark:archive": MARK_ARCHIVE,
        "mark:unarchive": MARK_UNARCHIVE,
        "mark:update-entity-types": MARK_UPDATE_ENTITY_TYPES,
        "match:search-requested": MATCH_SEARCH_REQUESTED,
        "match:resources-requested": MATCH_RESOURCES_REQUESTED,
        "match:limits-requested": MATCH_LIMITS_REQUESTED,
        "weave:rebuild": WEAVE_REBUILD,
        "smelt:rebuild-anchors": SMELT_REBUILD_ANCHORS,
        "yield:create": YIELD_CREATE,
        "yield:clone-persist": YIELD_CLONE_PERSIST,
        "yield:update": YIELD_UPDATE,
        "yield:clone-create": YIELD_CLONE_CREATE,
        "yield:clone-resource-requested": YIELD_CLONE_RESOURCE_REQUESTED,
        "yield:clone-token-requested": YIELD_CLONE_TOKEN_REQUESTED,
    }
)
