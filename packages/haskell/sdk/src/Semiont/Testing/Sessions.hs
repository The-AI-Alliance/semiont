{-# LANGUAGE OverloadedStrings #-}
-- | A registry factory of real sessions. Tests script answers, credentials,
-- and renewals explicitly; anything left unscripted is refused by name.
module Semiont.Testing.Sessions
  ( ScriptedSessions, newScriptedSessions, factory, refuseWhen, refuseToBuild
  , saysWho, answersAfter, queueRenewals, renewed, transports, revoked
  ) where

import Control.Concurrent.STM
import Control.Exception (finally, onException, throwIO)
import Control.Monad (forM_, when)
import Data.Aeson (Object, Value)
import Data.Scientific (Scientific)
import Data.Text (Text)
import qualified Data.Set as Set
import qualified Semiont.Bus as Bus
import qualified Semiont.Client as Client
import qualified Semiont.Content as Content
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (SessionError(..),SignInError(..),TransportError(..))
import qualified Semiont.Gateway as Gateway
import qualified Semiont.Channels as Channels
import qualified Semiont.Registry.Factory as Factory
import qualified Semiont.Registry.Stored as Stored
import Semiont.Retry (RetryOptions(..))
import qualified Semiont.Session as Session
import qualified Semiont.State.SessionSignals as Signals
import qualified Semiont.Testing.Transport as Faulty
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Types

data ScriptedSessions = ScriptedSessions RetryOptions Bus.BusOptions Timing.Settings (IO Scientific)
  (Text -> Text -> Object -> IO (Maybe Value)) (Text -> IO (Content.ContentTransport,Maybe Gateway.GatewayOperations))
  (TVar (Text -> Text -> Object -> IO (Maybe Object))) (TVar (Maybe Text)) (TVar (Maybe UserResponse)) (TVar Integer)
  (TQueue (Either SignInError (Maybe Text))) (TVar Integer) (TVar [(Text,Faulty.FaultyTransport)]) (TVar [StoredSession])

newScriptedSessions :: RetryOptions -> Bus.BusOptions -> Timing.Settings -> IO Scientific
  -> (Text -> Text -> Object -> IO (Maybe Value)) -> (Text -> IO (Content.ContentTransport,Maybe Gateway.GatewayOperations)) -> IO ScriptedSessions
newScriptedSessions clock bus timing wall answer content=atomically $
  ScriptedSessions clock bus timing wall answer content <$> newTVar (\_ _ _->pure Nothing) <*> newTVar Nothing
    <*> newTVar Nothing <*> newTVar 0 <*> newTQueue <*> newTVar 0 <*> newTVar [] <*> newTVar []

refuseWhen :: ScriptedSessions -> (Text -> Text -> Object -> IO (Maybe Object)) -> IO ()
refuseWhen (ScriptedSessions _ _ _ _ _ _ value _ _ _ _ _ _ _) = atomically . writeTVar value
refuseToBuild :: ScriptedSessions -> Maybe Text -> IO ()
refuseToBuild (ScriptedSessions _ _ _ _ _ _ _ value _ _ _ _ _ _) = atomically . writeTVar value
saysWho :: ScriptedSessions -> Maybe UserResponse -> IO ()
saysWho (ScriptedSessions _ _ _ _ _ _ _ _ value _ _ _ _ _) = atomically . writeTVar value
answersAfter :: ScriptedSessions -> Integer -> IO ()
answersAfter (ScriptedSessions _ _ _ _ _ _ _ _ _ value _ _ _ _) delay = do
  when (delay<0) (ioError (userError "validation delay must be nonnegative"))
  atomically (writeTVar value delay)
queueRenewals :: ScriptedSessions -> [Either SignInError (Maybe Text)] -> IO ()
queueRenewals (ScriptedSessions _ _ _ _ _ _ _ _ _ _ queue _ _ _) = atomically . mapM_ (writeTQueue queue)
renewed :: ScriptedSessions -> IO Integer
renewed (ScriptedSessions _ _ _ _ _ _ _ _ _ _ _ value _ _) = readTVarIO value
transports :: ScriptedSessions -> Text -> IO [Faulty.FaultyTransport]
transports (ScriptedSessions _ _ _ _ _ _ _ _ _ _ _ _ built _) key = map snd . filter ((==key) . fst) <$> readTVarIO built
revoked :: ScriptedSessions -> IO [StoredSession]
revoked (ScriptedSessions _ _ _ _ _ _ _ _ _ _ _ _ _ value) = readTVarIO value

factory :: ScriptedSessions -> Factory.SessionFactory
factory (ScriptedSessions clock bus timing wall answer content refusal buildRefusal user delay renewals count built revocations) = Factory.SessionFactory open
  (\grant->atomically (modifyTVar' revocations (++[grant])))
  where
    open inputs = do
      let kb=Factory.sessionFactoryOptionsKb inputs
          key=knowledgeBaseId kb
      rejected <- readTVarIO buildRefusal
      forM_ rejected (\reason->throwIO (SessionError Code.SessionConstructFailed reason key))
      over <- Faulty.newFaultyTransport clock [] (answer key) (Set.fromList Channels.channelNames)
      Faulty.refuseWhen over (\operation payload->readTVarIO refusal >>= \refuse->refuse key operation payload)
      (contents,gateway) <- content key `onException` Transport.dispose (Faulty.carrier over)
      client <- Client.newClient (Faulty.carrier over) contents gateway bus timing
        (Just (Client.CachePersistence (Factory.sessionFactoryOptionsStorage inputs) key ((*1000) <$> wall)))
        `onException` (Content.dispose contents `finally` Transport.dispose (Faulty.carrier over))
      atomically (modifyTVar' built (++[(key,over)]))
      let kept=Stored.keptIn (Factory.sessionFactoryOptionsStorage inputs) key
      let renew _ = do
            next <- atomically (modifyTVar' count (+1) >> tryReadTQueue renewals)
            case next of
              Nothing->throwIO (SignInError Code.SignInExchange ("Unscripted renewal of "<>key) Nothing)
              Just value->either throwIO pure value
          validate _ _ = do
            wait <- readTVarIO delay
            now <- retryNow clock
            when (wait>0) (retryWaitUntil clock (now+wait*1000000))
            who <- readTVarIO user
            maybe (throwIO (TransportError Code.TransportError ("Unscripted user of "<>key) Nothing Nothing)) (pure . Just) who
          options=Session.SessionOptions key (KbTarget (knowledgeBaseEndpoint kb) key (knowledgeBaseLabel kb) mempty) kept Nothing
            (Just renew) (Just validate) (atomically . Signals.notifySessionEnded (Factory.sessionFactoryOptionsSignals inputs)) (Factory.sessionFactoryOptionsOnError inputs) wall
      session <- Session.newSession client options clock timing `onException` Client.dispose client
      pure (Session.OpenedSession session (Session.dispose session `finally` Client.dispose client))
