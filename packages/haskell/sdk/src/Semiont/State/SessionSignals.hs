-- | Host-owned notices, independent of a session's headless credential state.
module Semiont.State.SessionSignals
  ( SessionSignals, SessionEnded(..), PermissionDenied(..), KbIdentityConflict(..), SessionEndReason(..)
  , newSessionSignals, sessionEnded, permissionDenied, kbIdentityConflict
  , notifySessionEnded, notifyPermissionDenied, notifyKbIdentityConflict
  , acknowledgeSessionEnded, acknowledgePermissionDenied, acknowledgeKbIdentityConflict, dispose
  ) where

import Control.Concurrent.STM
import Control.Monad (unless)
import Data.Text (Text)
import qualified Semiont.Internal.StateValue as State
import Semiont.Types (SessionEnded(..), PermissionDenied(..), KbIdentityConflict(..), SessionEndReason(..))

data SessionSignals = SessionSignals
  (State.StateValue (Maybe SessionEnded))
  (State.StateValue (Maybe PermissionDenied))
  (State.StateValue (Maybe KbIdentityConflict))
  (TVar Bool)

newSessionSignals :: IO SessionSignals
newSessionSignals=atomically (SessionSignals <$> State.newStateValue Nothing <*> State.newStateValue Nothing <*> State.newStateValue Nothing <*> newTVar False)
sessionEnded :: SessionSignals -> State.StateValue (Maybe SessionEnded)
sessionEnded (SessionSignals value _ _ _)=value
permissionDenied :: SessionSignals -> State.StateValue (Maybe PermissionDenied)
permissionDenied (SessionSignals _ value _ _)=value
kbIdentityConflict :: SessionSignals -> State.StateValue (Maybe KbIdentityConflict)
kbIdentityConflict (SessionSignals _ _ value _)=value
change :: SessionSignals -> State.StateValue value -> value -> STM ()
change (SessionSignals _ _ _ closed) state value=readTVar closed >>= \over -> unless over (State.update state value)
notifySessionEnded :: SessionSignals -> SessionEndReason -> STM ()
notifySessionEnded signals reason=change signals (sessionEnded signals) (Just (SessionEnded reason))
notifyPermissionDenied :: SessionSignals -> Maybe Text -> STM ()
notifyPermissionDenied signals detail=change signals (permissionDenied signals) (Just (PermissionDenied detail))
notifyKbIdentityConflict :: SessionSignals -> KbIdentityConflict -> STM ()
notifyKbIdentityConflict signals notice=change signals (kbIdentityConflict signals) (Just notice)
acknowledgeSessionEnded, acknowledgePermissionDenied, acknowledgeKbIdentityConflict :: SessionSignals -> STM ()
acknowledgeSessionEnded signals=change signals (sessionEnded signals) Nothing
acknowledgePermissionDenied signals=change signals (permissionDenied signals) Nothing
acknowledgeKbIdentityConflict signals=change signals (kbIdentityConflict signals) Nothing
dispose :: SessionSignals -> IO ()
dispose (SessionSignals ended denied conflict closed)=atomically $ do
  writeTVar closed True
  State.complete ended
  State.complete denied
  State.complete conflict
