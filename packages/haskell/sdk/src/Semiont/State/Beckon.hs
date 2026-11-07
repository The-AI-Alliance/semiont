{-# LANGUAGE OverloadedStrings #-}
-- | Attention for one resource, heard on the client's own signal plane.
module Semiont.State.Beckon (BeckonStateUnit, newBeckonStateUnit, hoveredAnnotationId, focus, dispose) where

import Data.Aeson (Value(..))
import Control.Concurrent.STM
import Control.Exception (finally)
import Control.Monad (unless)
import qualified Semiont.Client as Client
import Semiont.Channels
import qualified Semiont.Internal.Local as Local
import qualified Semiont.Internal.StateTasks as Tasks
import qualified Semiont.Internal.StateValue as State
import qualified Semiont.Internal.Transport as Transport
import Semiont.Types

data BeckonStateUnit = BeckonStateUnit Tasks.Tasks Client.Client ResourceId (State.StateValue (Maybe AnnotationId))

newBeckonStateUnit :: Client.Client -> ResourceId -> IO BeckonStateUnit
newBeckonStateUnit client resource = do
  tasks <- Tasks.newTasks "beckon state unit is closed"
  unit <- BeckonStateUnit tasks client resource <$> atomically (State.newStateValue Nothing)
  Tasks.listen tasks (Client.bus client) [channelName BeckonHover,channelName BrowseClick] $ \frame -> do
    let envelope=Transport.wireFrame frame
        payload=Object (busFramePayloadAdditionalProperties (busFramePayload envelope))
    if busFrameChannel envelope==channelName BeckonHover then case decodePayload BeckonHover payload of
      Left _ -> pure ()
      Right value -> atomically $ do
        let annotation=beckonHoverEventAnnotationId value
        State.update (hoveredAnnotationId unit) annotation
        mapM_ (\identity -> Local.signal (Client.bus client) BeckonSparkle (BeckonSparkleEvent identity mempty) NoScope) annotation
    else case decodePayload BrowseClick payload of
      Left _ -> pure ()
      Right value -> focus unit (browseClickEventAnnotationId value)
  pure unit

hoveredAnnotationId :: BeckonStateUnit -> State.StateValue (Maybe AnnotationId)
hoveredAnnotationId (BeckonStateUnit _ _ _ value) = value
focus :: BeckonStateUnit -> AnnotationId -> IO ()
focus (BeckonStateUnit tasks client resource _) identity = atomically $ do
  over <- Tasks.closed tasks
  unless over (Local.signal (Client.bus client) BeckonFocus (BeckonFocusEvent (Just identity) resource mempty) NoScope)
dispose :: BeckonStateUnit -> IO ()
dispose unit@(BeckonStateUnit tasks _ _ _) = Tasks.dispose tasks `finally` atomically (State.complete (hoveredAnnotationId unit))
