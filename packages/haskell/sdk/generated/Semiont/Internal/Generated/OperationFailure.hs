-- Generated from protocol/specs/src/bus/registry.json and protocol/specs/src/errors/codes.json. Do not edit.
{-# LANGUAGE DataKinds, GADTs, KindSignatures, OverloadedStrings #-}
module Semiont.Internal.Generated.OperationFailure (message, code) where
import Data.Text (Text)
import Semiont.Channels
import Semiont.ErrorCodes (BusRequestCode(..))
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
-- | The bus request code of an operation's failure: the one its code is read as, and for no code the
-- unrecognized failure's.
code :: Operation input output failure -> failure -> BusRequestCode
code BindUpdateBodyOperation = fromCommandErrorCode . Types.commandErrorCode
code BrowseResourceRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code BrowseResourcesRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code BrowseAnnotationRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code BrowseAnnotationHistoryRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code BrowseEventsRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code BrowseEntityTypesRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code BrowseTagSchemasRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code BrowseEnginesRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code BrowseProfilesRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code BrowseKbRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code BrowseDirectoryRequestedOperation = fromBrowseDirectoryFailedCode . Types.browseDirectoryFailedCode
code FrameAddEntityTypeOperation = fromCommandErrorCode . Types.commandErrorCode
code FrameAddTagSchemaOperation = fromCommandErrorCode . Types.commandErrorCode
code GatherRequestedOperation = fromGatherFailedCode . Types.gatherFailedCode
code GatherResourceRequestedOperation = fromGatherResourceFailedCode . Types.gatherResourceFailedCode
code GatherSummaryRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code GatherReferencedByRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code GatherLimitsRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code JobCreateOperation = fromCommandErrorCode . Types.commandErrorCode
code JobStatusRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code JobLimitsRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code JobCancelRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code JobClaimOperation = fromCommandErrorCode . Types.commandErrorCode
code MarkCreateRequestOperation = fromCommandErrorCode . Types.commandErrorCode
code MarkCommitOperation = fromCommandErrorCode . Types.commandErrorCode
code MarkDeleteOperation = fromCommandErrorCode . Types.commandErrorCode
code MarkArchiveOperation = fromCommandErrorCode . Types.commandErrorCode
code MarkUnarchiveOperation = fromCommandErrorCode . Types.commandErrorCode
code MarkUpdateEntityTypesOperation = fromCommandErrorCode . Types.commandErrorCode
code MatchSearchRequestedOperation = fromMatchSearchFailedCode . Types.matchSearchFailedCode
code MatchResourcesRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code MatchLimitsRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code WeaveRebuildOperation = fromCommandErrorCode . Types.commandErrorCode
code SmeltRebuildAnchorsOperation = fromCommandErrorCode . Types.commandErrorCode
code YieldCreateOperation = fromCommandErrorCode . Types.commandErrorCode
code YieldClonePersistOperation = fromCommandErrorCode . Types.commandErrorCode
code YieldUpdateOperation = fromCommandErrorCode . Types.commandErrorCode
code YieldCloneCreateOperation = fromCommandErrorCode . Types.commandErrorCode
code YieldCloneResourceRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
code YieldCloneTokenRequestedOperation = fromCommandErrorCode . Types.commandErrorCode
fromCommandErrorCode :: Maybe Types.CommandErrorCode -> BusRequestCode
fromCommandErrorCode value = case value of
  Nothing -> BusRequestRejected
  Just Types.CommandErrorCodePeerU2d_unavailable -> BusRequestPeerUnavailable
  Just Types.CommandErrorCodeNotU2d_found -> BusRequestNotFound
  Just Types.CommandErrorCodeUnauthorized -> BusRequestUnauthorized
  Just Types.CommandErrorCodeNoneU2d_pending -> BusRequestNonePending
fromBrowseDirectoryFailedCode :: Maybe Types.BrowseDirectoryFailedCode -> BusRequestCode
fromBrowseDirectoryFailedCode value = case value of
  Nothing -> BusRequestRejected
  Just Types.BrowseDirectoryFailedCodePeerU2d_unavailable -> BusRequestPeerUnavailable
  Just Types.BrowseDirectoryFailedCodeNotU2d_found -> BusRequestNotFound
  Just Types.BrowseDirectoryFailedCodeUnauthorized -> BusRequestUnauthorized
  Just Types.BrowseDirectoryFailedCodeNoneU2d_pending -> BusRequestNonePending
fromGatherFailedCode :: Maybe Types.GatherFailedCode -> BusRequestCode
fromGatherFailedCode value = case value of
  Nothing -> BusRequestRejected
  Just Types.GatherFailedCodePeerU2d_unavailable -> BusRequestPeerUnavailable
  Just Types.GatherFailedCodeNotU2d_found -> BusRequestNotFound
  Just Types.GatherFailedCodeUnauthorized -> BusRequestUnauthorized
  Just Types.GatherFailedCodeNoneU2d_pending -> BusRequestNonePending
fromGatherResourceFailedCode :: Maybe Types.GatherResourceFailedCode -> BusRequestCode
fromGatherResourceFailedCode value = case value of
  Nothing -> BusRequestRejected
  Just Types.GatherResourceFailedCodePeerU2d_unavailable -> BusRequestPeerUnavailable
  Just Types.GatherResourceFailedCodeNotU2d_found -> BusRequestNotFound
  Just Types.GatherResourceFailedCodeUnauthorized -> BusRequestUnauthorized
  Just Types.GatherResourceFailedCodeNoneU2d_pending -> BusRequestNonePending
fromMatchSearchFailedCode :: Maybe Types.MatchSearchFailedCode -> BusRequestCode
fromMatchSearchFailedCode value = case value of
  Nothing -> BusRequestRejected
  Just Types.MatchSearchFailedCodePeerU2d_unavailable -> BusRequestPeerUnavailable
  Just Types.MatchSearchFailedCodeNotU2d_found -> BusRequestNotFound
  Just Types.MatchSearchFailedCodeUnauthorized -> BusRequestUnauthorized
  Just Types.MatchSearchFailedCodeNoneU2d_pending -> BusRequestNonePending
