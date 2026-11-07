{-# LANGUAGE OverloadedStrings #-}
-- | Independent annotation and resource gathers; each answer lands when it
-- arrives, without cancelling another request.
module Semiont.State.Gather
  ( GatherStateUnit, newGatherStateUnit, context, loading, error, annotationId
  , resourceContext, resourceLoading, resourceError, gatherAnnotation, gatherResource, dispose
  ) where

import Prelude hiding (error)
import Control.Concurrent.STM
import Control.Exception (SomeException, catches, Handler(..), finally, toException)
import Control.Monad (unless, when)
import qualified Semiont.Client as Client
import Semiont.Errors (BusRequestError, TransportError)
import qualified Semiont.Gather as Gather
import qualified Semiont.Internal.StateTasks as Tasks
import qualified Semiont.Internal.StateValue as State
import qualified Semiont.Running as Running
import Semiont.Types hiding (annotationId)

data Slot = Slot (State.StateValue (Maybe GatheredContext)) (State.StateValue Bool) (State.StateValue (Maybe SomeException))
data GatherStateUnit = GatherStateUnit Tasks.Tasks Client.Client ResourceId Slot (State.StateValue (Maybe AnnotationId)) Slot
newSlot :: STM Slot
newSlot = Slot <$> State.newStateValue Nothing <*> State.newStateValue False <*> State.newStateValue Nothing
newGatherStateUnit :: Client.Client -> ResourceId -> IO GatherStateUnit
newGatherStateUnit client resource = do
  tasks <- Tasks.newTasks "gather state unit is closed"
  atomically (GatherStateUnit tasks client resource <$> newSlot <*> State.newStateValue Nothing <*> newSlot)

context, resourceContext :: GatherStateUnit -> State.StateValue (Maybe GatheredContext)
context (GatherStateUnit _ _ _ (Slot value _ _) _ _) = value
resourceContext (GatherStateUnit _ _ _ _ _ (Slot value _ _)) = value
loading, resourceLoading :: GatherStateUnit -> State.StateValue Bool
loading (GatherStateUnit _ _ _ (Slot _ value _) _ _) = value
resourceLoading (GatherStateUnit _ _ _ _ _ (Slot _ value _)) = value
error, resourceError :: GatherStateUnit -> State.StateValue (Maybe SomeException)
error (GatherStateUnit _ _ _ (Slot _ _ value) _ _) = value
resourceError (GatherStateUnit _ _ _ _ _ (Slot _ _ value)) = value
annotationId :: GatherStateUnit -> State.StateValue (Maybe AnnotationId)
annotationId (GatherStateUnit _ _ _ _ value _) = value

begin :: Slot -> STM ()
begin (Slot value busy failed) = State.update value Nothing >> State.update failed Nothing >> State.update busy True
land :: Slot -> IO GatheredContext -> IO ()
land (Slot value busy failed) action = do
  let success=action >>= atomically . State.update value . Just
      refused :: SomeException -> IO ()
      refused problem=atomically (State.update failed (Just problem))
  success `catches` [Handler (refused . toException :: BusRequestError -> IO ()),Handler (refused . toException :: TransportError -> IO ())]
  atomically (State.update busy False)

gatherAnnotation :: GatherStateUnit -> AnnotationId -> Maybe GatherAnnotationOptions -> IO ()
gatherAnnotation unit@(GatherStateUnit tasks client resource slot _ _) identity options = do
  accepted <- atomically $ do
    over <- Tasks.closed tasks
    unless over (begin slot >> State.update (annotationId unit) (Just identity))
    pure (not over)
  when accepted (Tasks.fork tasks (land slot (gatherAnnotationCompleteResponse <$> (Gather.annotation (Client.gather client) resource identity options >>= Running.await))))
gatherResource :: GatherStateUnit -> ResourceId -> Maybe GatherResourceOptions -> IO ()
gatherResource (GatherStateUnit tasks client _ _ _ slot) identity options = do
  accepted <- atomically $ do over<-Tasks.closed tasks; unless over (begin slot); pure (not over)
  when accepted (Tasks.fork tasks (land slot (Gather.resource (Client.gather client) identity options)))

dispose :: GatherStateUnit -> IO ()
dispose (GatherStateUnit tasks _ _ annotation identity resource) = Tasks.dispose tasks `finally` atomically (end annotation >> State.complete identity >> end resource)
  where end (Slot value busy failed) = State.complete value >> State.complete busy >> State.complete failed
