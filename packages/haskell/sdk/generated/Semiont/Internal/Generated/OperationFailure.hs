-- Generated from protocol/specs/src/bus/registry.json. Do not edit.
{-# LANGUAGE DataKinds, GADTs, KindSignatures, OverloadedStrings #-}
module Semiont.Internal.Generated.OperationFailure (message) where
import Data.Text (Text)
import Semiont.Channels
import qualified Semiont.Types as Types
message :: Operation input output failure -> failure -> Text
message BindUpdateBodyOperation = Types.commandErrorMessage
message BrowseResourceRequestedOperation = Types.commandErrorMessage
message BrowseResourcesRequestedOperation = Types.commandErrorMessage
message BrowseAnnotationRequestedOperation = Types.commandErrorMessage
message BrowseAnnotationHistoryRequestedOperation = Types.commandErrorMessage
message BrowseEventsRequestedOperation = Types.commandErrorMessage
message BrowseEntityTypesRequestedOperation = Types.commandErrorMessage
message BrowseTagSchemasRequestedOperation = Types.commandErrorMessage
message BrowseEnginesRequestedOperation = Types.commandErrorMessage
message BrowseProfilesRequestedOperation = Types.commandErrorMessage
message BrowseKbRequestedOperation = Types.commandErrorMessage
message BrowseDirectoryRequestedOperation = Types.browseDirectoryFailedMessage
message FrameAddEntityTypeOperation = Types.commandErrorMessage
message FrameAddTagSchemaOperation = Types.commandErrorMessage
message GatherRequestedOperation = Types.gatherFailedMessage
message GatherResourceRequestedOperation = Types.gatherResourceFailedMessage
message GatherSummaryRequestedOperation = Types.commandErrorMessage
message GatherReferencedByRequestedOperation = Types.commandErrorMessage
message GatherLimitsRequestedOperation = Types.commandErrorMessage
message JobCreateOperation = Types.commandErrorMessage
message JobStatusRequestedOperation = Types.commandErrorMessage
message JobLimitsRequestedOperation = Types.commandErrorMessage
message JobCancelRequestedOperation = Types.commandErrorMessage
message JobClaimOperation = Types.commandErrorMessage
message MarkCreateRequestOperation = Types.commandErrorMessage
message MarkCommitOperation = Types.commandErrorMessage
message MarkDeleteOperation = Types.commandErrorMessage
message MarkArchiveOperation = Types.commandErrorMessage
message MarkUnarchiveOperation = Types.commandErrorMessage
message MarkUpdateEntityTypesOperation = Types.commandErrorMessage
message MatchSearchRequestedOperation = Types.matchSearchFailedMessage
message MatchResourcesRequestedOperation = Types.commandErrorMessage
message MatchLimitsRequestedOperation = Types.commandErrorMessage
message WeaveRebuildOperation = Types.commandErrorMessage
message SmeltRebuildAnchorsOperation = Types.commandErrorMessage
message YieldCreateOperation = Types.commandErrorMessage
message YieldClonePersistOperation = Types.commandErrorMessage
message YieldUpdateOperation = Types.commandErrorMessage
message YieldCloneCreateOperation = Types.commandErrorMessage
message YieldCloneResourceRequestedOperation = Types.commandErrorMessage
message YieldCloneTokenRequestedOperation = Types.commandErrorMessage
