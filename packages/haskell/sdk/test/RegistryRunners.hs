{-# LANGUAGE OverloadedStrings #-}
-- | What the registry-errors and registry-activation runners share: reading a row, the factory of HTTP sessions over
-- the stage whose clients keep in a storage the runner holds, a read that leaves a client owing a save, and a reader
-- of a registry's errors.
module RegistryRunners
  ( failure, field, stated, fixture, agreeOn, eventually
  , Saying(..), Doubles(..), newDoubles, factoryOf, holding, reading
  ) where

import Control.Concurrent.Async (poll, wait, withAsync)
import Control.Concurrent.STM
import Control.Exception (onException)
import Control.Monad (unless, void, when)
import Data.Aeson (FromJSON, Value(..), fromJSON, Result(..))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.Map.Strict as Map
import Data.Maybe (isJust)
import Data.Text (Text)
import qualified Data.Text as Text
import qualified ControlledTime as Time
import GatewayStage (signInOf)
import SessionCases (jwt)
import qualified Semiont.Browse as Browse
import qualified Semiont.Cache as Cache
import qualified Semiont.Client as Client
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (SessionError(..), TransportError(..))
import qualified Semiont.Gateway as Gateway
import qualified Semiont.Http as Http
import Semiont.Internal.Kept (personKey)
import Semiont.Internal.Transport (reportFailure)
import qualified Semiont.Issuer as Issuer
import qualified Semiont.Registry as Browser
import qualified Semiont.Registry.Factory as Factory
import qualified Semiont.Session as Session
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.SignIn as SignIn
import qualified Semiont.State.SessionSignals as Signals
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types
import qualified Streaming.Prelude as Stream

failure :: Text -> String -> IO result
failure why message = ioError (userError ("registry case " ++ show why ++ ": " ++ message))

field :: FromJSON value => Text -> Text -> Value -> IO value
field why name (Object fields) = case KM.lookup (Key.fromText name) fields of
  Just value | Success parsed <- fromJSON value -> pure parsed
  _ -> failure why ("states no " ++ Text.unpack name ++ " of its kind")
field why _ _ = failure why "is no object"

-- | A member a row may leave out.
stated :: FromJSON value => Text -> Text -> Value -> IO (Maybe value)
stated why name (Object fields) = case KM.lookup (Key.fromText name) fields of
  Nothing -> pure Nothing
  Just value | Success parsed <- fromJSON value -> pure (Just parsed)
  Just _ -> failure why ("states a " ++ Text.unpack name ++ " of no kind the table names")
stated why _ _ = failure why "is no object"

fixture :: FromJSON result => Map.Map Text Value -> Text -> IO result
fixture fixtures name = case Map.lookup name fixtures of
  Just value | Success parsed <- fromJSON value -> pure parsed
  _ -> ioError (userError ("no " ++ Text.unpack name ++ " fixture for the registry cases"))

agreeOn :: (Eq value, Show value) => Text -> String -> value -> value -> IO ()
agreeOn why what found tabled = unless (found == tabled) (failure why (what ++ ": " ++ show found ++ "; the table's is " ++ show tabled))

-- | Waits for probe, the controlled clock moved on by a reconnect's debounce at a time.
eventually :: Time.ControlledTime -> Text -> String -> IO Bool -> IO ()
eventually time why what probe = do
  seen <- Time.within time (Timing.reconnectDebounceMs Timing.protocolSettings * 1000000) probe
  unless seen (failure why ("never saw " ++ what))

-- | One thing a session says: one of its own errors, or a failure of its transport with its message.
data Saying = Own Code.SessionCode | Failing Code.TransportCode Text deriving Eq

-- | The runner's hold on the sessions the factory builds.
data Doubles = Doubles
  { refusing :: TVar Bool
  -- ^ The storage the session's client keeps in refuses each write.
  , refused :: TVar Int
  -- ^ The writes it refused.
  , withholding :: TVar Bool
  -- ^ That storage answers no write until this is cleared.
  , withheld :: TVar Int
  -- ^ The writes it made wait.
  , unreadable :: TVar Bool
  -- ^ The session's sign-in cannot be read.
  , unread :: TVar Int
  -- ^ The reads of it that failed.
  , unrecordable :: TVar Bool
  -- ^ The session's sign-in cannot record the person the gateway names.
  , handed :: TVar [Maybe Text]
  -- ^ What each renewal of the session was handed.
  , listening :: TMVar ()
  -- ^ The registry's errors are being read; the factory builds nothing before.
  , asking :: TMVar ()
  -- ^ The session's startup may ask who its token is.
  }

newDoubles :: Bool -> IO Doubles
newDoubles refusingAll = atomically $ Doubles <$> newTVar refusingAll <*> newTVar 0 <*> newTVar False <*> newTVar 0
  <*> newTVar False <*> newTVar 0 <*> newTVar False <*> newTVar [] <*> newEmptyTMVar <*> newEmptyTMVar

-- | Fails for reason while flag holds, noting the failure first.
failWhile :: TVar Bool -> STM () -> String -> IO ()
failWhile flag noted reason = do
  failing <- atomically $ do
    on <- readTVar flag
    when on noted
    pure on
  when failing (ioError (userError reason))

-- | Waits while flag holds, noting the wait first.
waitWhile :: TVar Bool -> STM () -> IO ()
waitWhile flag noted = do
  waits <- atomically $ do
    on <- readTVar flag
    when on noted
    pure on
  when waits (atomically (readTVar flag >>= check . not))

-- | The knowledge base's HTTP session over the stage, for person, reading none of its errors. Its client keeps in a
-- storage the doubles hold and refuse writes to, which tells written of each write it is asked to make, by its key,
-- before it answers it; its sign-in, in memory, names person and fails as the doubles say; its renewal records what
-- it is handed. What the case has it say as the factory builds it, it says then.
factoryOf :: Text -> Doubles -> Http.HttpOptions -> UserResponse -> [Saying] -> (Text -> IO ()) -> IO Factory.SessionFactory
factoryOf why doubles http person opening written = do
  underlying <- Storage.newMemoryStorage
  let answer key = written key >> waitWhile (withholding doubles) (modifyTVar' (withheld doubles) (+1))
        >> failWhile (refusing doubles) (modifyTVar' (refused doubles) (+1)) "the storage refuses every write"
      keeping = Storage.SessionStorage (Storage.get underlying) (\key value -> answer key >> Storage.set underlying key value)
        (\key -> answer key >> Storage.delete underlying key) (\key change -> answer key >> Storage.update underlying key change)
        (Storage.subscribe underlying)
      named = personKey (userIdValue (userResponseDid person))
      open inputs = do
        atomically (readTMVar (listening doubles))
        let kb = Factory.sessionFactoryOptionsKb inputs
        endpoint <- case knowledgeBaseEndpoint kb of
          KbEndpointBranch1 value -> pure value
          KbEndpointBranch2 _ -> failure why "registers a knowledge base the stage does not serve"
        base <- either (failure why . Text.unpack) pure (Gateway.gatewayUrl endpoint)
        memory <- SignIn.newMemorySignIn
        SignIn.keep memory (signInOf Issuer.browserClientId (jwt 3600 1) "r1" (Just named))
        let kept = memory
              { SignIn.held = failWhile (unreadable doubles) (modifyTVar' (unread doubles) (+1)) "the sign-in cannot be read"
                  >> SignIn.held memory
              , SignIn.recordPersonKey = \access key -> failWhile (unrecordable doubles) (pure ()) "the sign-in cannot record a person"
                  >> SignIn.recordPersonKey memory access key
              }
            renew given = atomically (modifyTVar' (handed doubles) (<> [given])) >> pure (Just (jwt 7200 2))
            validate _ _ = atomically (readTMVar (asking doubles)) >> pure (Just person)
            settings = Session.SessionOptions (knowledgeBaseId kb)
              (KbTarget (knowledgeBaseEndpoint kb) (knowledgeBaseId kb) (knowledgeBaseLabel kb) mempty) kept Nothing (Just renew)
              (Just validate) (atomically . Signals.notifySessionEnded (Factory.sessionFactoryOptionsSignals inputs)) (pure 1800000000)
        opened <- Session.fromHttp http { Http.httpBaseUrl = base } (Just keeping) settings
        (mapM_ (sayOpening (Session.openedSession opened)) opening >> atomically (void (tryPutTMVar (asking doubles) ())))
          `onException` Session.closeOpenedSession opened
        pure opened
      -- The runner waits in a transaction while the factory builds, so this settling is of everything else.
      sayOpening session said = case said of
        Own Code.SessionKeepFailed -> do
          atomically (writeTVar (unrecordable doubles) True >> void (tryPutTMVar (asking doubles) ()))
          Session.ready session
          atomically (writeTVar (unrecordable doubles) False)
        Own code -> failure why ("says " ++ show (Code.sessionCode code) ++ " as its factory builds it, before its client holds anything")
        Failing code message -> reportFailure (Client.transport (Session.client session)) (TransportError code message Nothing Nothing)
          >> Time.settle
  pure (Factory.SessionFactory open (const (pure ())))

-- | The session's client asks the gateway for the resource of that name.
holding :: Text -> Time.ControlledTime -> Session.Session -> Text -> IO ()
holding why time session name = do
  identity <- either (failure why) pure (mkResourceId name)
  withAsync (Cache.fresh (Browse.resource (Client.browse (Session.client session)) identity)) $ \fetch -> do
    eventually time why (Text.unpack name ++ " fetched") (isJust <$> poll fetch)
    void (wait fetch)

-- | Everything said on the registry's errors, each as heard gives it, in order, until they end.
reading :: Doubles -> (SessionError -> said) -> TVar [said] -> Browser.SemiontBrowser -> IO ()
reading doubles heard said browser = Browser.errors browser $ \failures -> do
  atomically (putTMVar (listening doubles) ())
  Stream.mapM_ (\problem -> atomically (modifyTVar' said (<> [heard problem]))) failures
