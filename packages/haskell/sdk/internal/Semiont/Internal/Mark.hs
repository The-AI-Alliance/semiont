module Semiont.Internal.Mark (MarkNamespace, newMark, annotation, delete, archive, unarchive, updateEntityTypes, delegate, request, submit, reportDeleteError) where

import Control.Concurrent.STM (STM)
import Data.Text (Text)
import qualified Semiont.Bus as Bus
import Semiont.Channels hiding (MarkCreateRequest)
import qualified Semiont.Internal.Delegation as Delegation
import qualified Semiont.Internal.DelegatedVerbs as Verb
import qualified Semiont.Internal.Local as Local
import qualified Semiont.Internal.Running as Running
import qualified Semiont.Internal.Transport as LocalBus
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types

data MarkNamespace = MarkNamespace Bus.Bus LocalBus.EventBus Timing.Settings Delegation.Follower
newMark :: Bus.Bus -> LocalBus.EventBus -> Timing.Settings -> Delegation.Follower -> MarkNamespace
newMark = MarkNamespace
annotation :: MarkNamespace -> CreateAnnotationRequest -> IO AnnotationId
annotation (MarkNamespace wire _ timing _) input = markCreateOkResponseAnnotationId . markCreateOkResponse <$>
  Bus.request wire MarkCreateRequestOperation (MarkCreateRequest input (annotationTargetSource (createAnnotationRequestTarget input)) mempty) (Timing.busRequestTimeoutMs timing)
delete :: MarkNamespace -> ResourceId -> AnnotationId -> IO MarkDeleteOkResponse
delete (MarkNamespace wire _ timing _) resource mark = markDeleteOkResponse <$>
  Bus.request wire MarkDeleteOperation (MarkDeleteCommand Nothing mark (Just resource) mempty) (Timing.busRequestTimeoutMs timing)
archive :: MarkNamespace -> ResourceId -> IO EmptyBusPayload
archive (MarkNamespace wire _ timing _) resource =
  Bus.request wire MarkArchiveOperation (MarkArchiveCommand Nothing Nothing resource Nothing mempty) (Timing.busRequestTimeoutMs timing)
unarchive :: MarkNamespace -> ResourceId -> IO EmptyBusPayload
unarchive (MarkNamespace wire _ timing _) resource =
  Bus.request wire MarkUnarchiveOperation (MarkUnarchiveCommand Nothing resource Nothing mempty) (Timing.busRequestTimeoutMs timing)
updateEntityTypes :: MarkNamespace -> ResourceId -> [Text] -> [Text] -> IO EmptyBusPayload
updateEntityTypes (MarkNamespace wire _ timing _) resource current updated =
  Bus.request wire MarkUpdateEntityTypesOperation (MarkUpdateEntityTypesCommand Nothing current resource updated mempty) (Timing.busRequestTimeoutMs timing)
delegate :: MarkNamespace -> ResourceId -> MarkJobParams -> IO (Running.Running (Delegation.JobEvent MarkJobCompleteCommand) MarkJobCompleteCommand)
delegate (MarkNamespace _ _ _ follower) resource params = Delegation.follow follower
  (JobCreateCommandBranch1 (MarkJobCreateCommand Nothing Nothing MarkJobCreateCommandJobTypeMark params resource)) Verb.mark resource Nothing
request :: MarkNamespace -> ResourceId -> AnnotationSelector -> Motivation -> STM ()
request (MarkNamespace _ local _ _) resource selector motivation = Local.signal local MarkRequested (MarkRequestedEvent motivation selector resource mempty) NoScope
submit :: MarkNamespace -> MarkSubmitEvent -> STM ()
submit (MarkNamespace _ local _ _) input = Local.signal local MarkSubmit input NoScope
reportDeleteError :: MarkNamespace -> ResourceErrorEvent -> STM ()
reportDeleteError (MarkNamespace _ local _ _) input = Local.signal local MarkDeleteError input NoScope
