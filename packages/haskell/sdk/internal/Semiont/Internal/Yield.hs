{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Yield (YieldNamespace, newYield, resource, delegate, cloneToken, fromToken, createFromToken, clone) where

import Control.Concurrent.STM (STM)
import Data.Maybe (fromMaybe)
import Data.Scientific (Scientific)
import Data.Text (Text)
import Data.Text.Encoding (encodeUtf8)
import qualified Semiont.Bus as Bus
import Semiont.Channels
import qualified Semiont.Content as Content
import qualified Semiont.Internal.Delegation as Delegation
import qualified Semiont.Internal.DelegatedVerbs as Verb
import qualified Semiont.Internal.Local as Local
import qualified Semiont.Internal.Running as Running
import qualified Semiont.Internal.Transport as LocalBus
import qualified Semiont.MediaTypes as Media
import qualified Semiont.Resources as Resources
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types

data YieldNamespace = YieldNamespace Bus.Bus LocalBus.EventBus Content.ContentTransport Timing.Settings Delegation.Follower
newYield :: Bus.Bus -> LocalBus.EventBus -> Content.ContentTransport -> Timing.Settings -> Delegation.Follower -> YieldNamespace
newYield = YieldNamespace
resource :: YieldNamespace -> ResourceUploadMetadata -> Content.ReplayableBody -> IO (Running.Running Delegation.UploadEvent ResourceId)
resource (YieldNamespace _ _ content _ follower) metadata body = Running.newRunning $ \report -> Delegation.run follower $ do
  report (Delegation.UploadStarted (maybe 0 toInteger (Content.bodyLength body)))
  identity <- Content.putBinary content Nothing metadata body $ \notice -> report (Delegation.UploadProgress (Content.bytesUploaded notice) (Content.totalBytes notice))
  report (Delegation.UploadFinished identity)
  pure identity
delegate :: YieldNamespace -> GenerationJobParams -> Maybe Scientific -> IO (Running.Running (Delegation.JobEvent YieldJobCompleteCommand) YieldJobCompleteCommand)
delegate (YieldNamespace _ _ _ timing follower) params stall = Delegation.follow follower
  (JobCreateCommandBranch2 (YieldJobCreateCommand Nothing Nothing YieldJobCreateCommandJobTypeYield params)) Verb.yield identity
  (Just (fromMaybe (Delegation.deriveStallDeadlineMs timing (generationJobParamsMaxTokens params)) stall))
  where
    identity=case gatheredContextFocus (generationJobParamsContext params) of
      GatheredContextFocusBranch1 focus -> resourceDescriptorU40_id (gatheredContextFocusBranch1ValueSourceResource focus)
      GatheredContextFocusBranch2 focus -> resourceDescriptorU40_id (gatheredContextFocusBranch2ValueResource focus)
cloneToken :: YieldNamespace -> ResourceId -> IO CloneResourceWithTokenResponse
cloneToken (YieldNamespace wire _ _ timing _) identity = cloneResourceWithTokenResponseBusEnvelopeResponse <$>
  Bus.request wire YieldCloneTokenRequestedOperation (YieldCloneTokenRequest identity mempty) (Timing.busRequestTimeoutMs timing)
fromToken :: YieldNamespace -> Text -> IO ResourceDescriptor
fromToken (YieldNamespace wire _ _ timing _) token = getResourceByTokenResponseSourceResource . getResourceByTokenResponseBusEnvelopeResponse <$>
  Bus.request wire YieldCloneResourceRequestedOperation (YieldCloneResourceRequest token mempty) (Timing.busRequestTimeoutMs timing)
createFromToken :: YieldNamespace -> Text -> Text -> Text -> Maybe Bool -> IO ResourceId
createFromToken namespace@(YieldNamespace _ _ content _ follower) token name text archiveOriginal = Delegation.run follower $ do
  source <- fromToken namespace token
  let format=Media.cloneFormat (Resources.getPrimaryMediaType source)
  file <- either (ioError . userError . show) pure (Media.storageFileName name format)
  let metadata = ResourceUploadMetadata
        { resourceUploadMetadataArchiveOriginal=fmap (\value -> if value then "true" else "false") archiveOriginal
        , resourceUploadMetadataCloneToken=Just token, resourceUploadMetadataEntityTypes=Nothing
        , resourceUploadMetadataFormat=format, resourceUploadMetadataGenerationPrompt=Nothing
        , resourceUploadMetadataGenerator=Nothing, resourceUploadMetadataIsDraft=Nothing
        , resourceUploadMetadataJobId=Nothing, resourceUploadMetadataLanguage=Nothing
        , resourceUploadMetadataName=name, resourceUploadMetadataSourceAnnotationId=Nothing
        , resourceUploadMetadataSourceResourceId=Nothing, resourceUploadMetadataStorageUri="file://"<>file
        , resourceUploadMetadataAdditionalProperties=mempty }
  Content.putBinary content Nothing metadata (Content.bytesBody (encodeUtf8 text)) (const (pure ()))
clone :: YieldNamespace -> STM ()
clone (YieldNamespace _ local _ _ _) = Local.signal local YieldClone EmptyBusPayload NoScope
