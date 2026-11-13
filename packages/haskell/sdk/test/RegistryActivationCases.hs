{-# LANGUAGE OverloadedStrings #-}
-- | protocol/specs/src/session/registry-activation-cases.json: what a registry does when it activates a knowledge
-- base, when its factory refuses the session, once its close has begun, and when another knowledge base's session is
-- active; and protocol/specs/src/session/registry-factory-failure-cases.json: what it says when its factory fails with
-- something that is not one of the session's own errors.
--
-- Every row runs a registry of knowledge bases at the stage, kb-a stored as active, so the registry activates it as
-- it is made. Its factory records each knowledge base it is asked for a session of, in order, and then refuses as the
-- row says or builds the HTTP session the registry-errors runner's factory builds, whose sign-in is kept for the
-- fixture's person. Where a row's first session owes a save, a read of a resource leaves its client owing it, still
-- waiting out its debounce, and the storage its client keeps in records the write of it in the list the factory
-- records its asks in: `switching` holds the order of the two to the rule, and `closing` begins an activation from
-- within that write and another from this thread while the storage holds the write open. Then an activation taken
-- before the registry's close began, held in its factory as the close begins, ends as an overtaken one does, and a
-- close from within the factory returns there.
module RegistryActivationCases (registryActivationCases) where

import Control.Concurrent.Async (Async, AsyncCancelled, wait, withAsync)
import Control.Concurrent.STM
import Control.Exception (SomeException, bracket, mask_, throwIO, toException, try)
import Control.Monad (forM_, unless, void, when)
import Data.Aeson (Value(..), eitherDecodeStrict')
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.Map.Strict as Map
import Data.Maybe (isJust)
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as Text
import qualified ControlledTime as Time
import GatewayStage (newStage, stageHttp, registered)
import RegistryRunners
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (BusRequestError(..), SessionError(..), TransportError(..))
import qualified Semiont.Http as Http
import qualified Semiont.Internal.Browse as BrowseState
import Semiont.Internal.Generated.CachePersistence (KeptQuery(Resource))
import Semiont.Internal.Kept (cacheKey, lastEventIdKey, personKey)
import qualified Semiont.Client as Client
import qualified Semiont.Registry as Browser
import qualified Semiont.Registry.Factory as Factory
import qualified Semiont.Session as Session
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.StateValue as State
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types
import System.FilePath ((</>))
import System.Timeout (timeout)

askedFor :: Text -> Text
askedFor key = "asked for " <> key

wroteTheOwedSave :: Text
wroteTheOwedSave = "wrote the owed save"

-- | What was found agrees with the table's, the table's given first.
asTabled :: (Eq value, Show value) => Text -> String -> value -> value -> IO ()
asTabled why what tabled found = agreeOn why what found tabled

-- | A factory that records in steps each knowledge base it is asked for a session of, and then answers as answer does.
recording :: TVar [Text] -> Factory.SessionFactory -> Factory.SessionFactory
recording steps answer = answer
  { Factory.openSession = \inputs -> do
      atomically (modifyTVar' steps (<> [askedFor (knowledgeBaseId (Factory.sessionFactoryOptionsKb inputs))]))
      Factory.openSession answer inputs
  }

-- | Timing under which a client's save waits out its debounce for as long as a case runs.
unsaved :: Timing.Settings
unsaved = Timing.protocolSettings { Timing.saveDebounceMs = 3600000 }

-- | The key the person's kept resources are saved under by kb-a's client: the save a read of a resource leaves it owing.
owedSave :: UserResponse -> Text
owedSave person = cacheKey "kb-a" (personKey (userIdValue (userResponseDid person))) Resource

-- | Every key kb-a's client keeps the person's things under.
firstClientsKeys :: UserResponse -> Set.Set Text
firstClientsKeys person = Set.fromList (lastEventIdKey "kb-a" named : map (cacheKey "kb-a" named) [minBound .. maxBound])
  where named = personKey (userIdValue (userResponseDid person))

-- | A registry at the stage of kb-a and kb-b, kb-a stored as active, over the factory made for the stage, whose
-- sessions run under timing. Body is handed the controlled time, the registry, its storage, the reader of its errors,
-- read from before it activates anything until they end, and what that reader has heard, each as heard gives it.
atTheStage :: Doubles -> Timing.Settings -> (Http.HttpOptions -> IO Factory.SessionFactory) -> (SessionError -> said)
  -> (Time.ControlledTime -> Browser.SemiontBrowser -> Storage.SessionStorage -> Async () -> TVar [said] -> IO result) -> IO result
atTheStage doubles timing factoryFor heard body = do
  stage <- newStage
  time <- Time.newTime
  http <- stageHttp stage time timing
  factory <- factoryFor http
  store <- Storage.newMemoryStorage
  Browser.saveKnowledgeBases store [registered "kb-a", registered "kb-b"]
  Storage.set store Browser.activeKey "kb-a"
  said <- newTVarIO []
  bracket (Browser.newSemiontBrowser (Browser.SemiontBrowserConfig store factory http (pure 1800000000))) Browser.dispose $ \browser ->
    withAsync (reading doubles heard said browser) $ \reader -> do
      atomically (readTMVar (listening doubles))
      body time browser store reader said

activeOf :: Browser.SemiontBrowser -> IO Session.Session
activeOf browser = atomically (State.current (Browser.activeSession browser) >>= maybe retry pure)

-- | The session's client owes the save of the resource it read.
owing :: Text -> Time.ControlledTime -> Session.Session -> IO ()
owing why time session = do
  holding why time session "res-1"
  owes <- atomically (BrowseState.persistencePending (Client.browse (Session.client session)))
  unless owes (failure why "has a client that owes no save")

-- | One of the session's own errors, by its code and its message, refused of the knowledge base of that key.
own :: Text -> Text -> Value -> IO SessionError
own why key refusal = do
  code <- field why "own" refusal
  parsed <- maybe (failure why ("refuses with " ++ show code ++ ", no code of the session group")) pure (Code.parseSessionCode code)
  message <- field why "message" refusal
  pure (SessionError parsed message key)

-- | What is said on a registry's errors, by its code and its message.
saidOf :: SessionError -> (Text, Text)
saidOf problem = (Code.sessionCode (sessionErrorCode problem), sessionErrorMessage problem)

tabledSaid :: Text -> Value -> IO [(Text, Text)]
tabledSaid why row = field why "registryErrors" row >>= mapM (\said -> (,) <$> field why "code" said <*> field why "message" said)

-- | No session being active, a registry activates kb-a over a factory that refuses with refusal. What the registry
-- said on its errors once the activation returned, each by its code and its message; it then has no session active,
-- its factory was asked for one session, and the storage's active key names kb-a.
refusedWith :: Text -> SomeException -> IO [(Text, Text)]
refusedWith why refusal = do
  steps <- newTVarIO []
  doubles <- newDoubles False
  let refuser = Factory.SessionFactory (\_ -> throwIO refusal) (const (pure ()))
  atTheStage doubles Timing.protocolSettings (const (pure (recording steps refuser))) saidOf $ \_ browser store reader said -> do
    atomically $ do
      asked <- readTVar steps
      activating <- State.current (Browser.sessionActivating browser)
      check (not (null asked) && not activating)
    readTVarIO steps >>= asTabled why "the sessions the factory was asked for" [askedFor "kb-a"]
    active <- atomically (State.current (Browser.activeSession browser))
    when (isJust active) (failure why "has a session active once its factory refused it")
    Storage.get store Browser.activeKey >>= asTabled why "the storage's active key" (Just "kb-a")
    -- The registry has no session to close, so its close says nothing: what the reader heard to their end is what
    -- the activation said.
    Browser.dispose browser
    wait reader
    readTVarIO said

runRefused :: Value -> IO ()
runRefused row = do
  why <- field "a refused case" "why" row
  refusal <- field why "refusal" row >>= own why "kb-a"
  tabled <- tabledSaid why row
  said <- refusedWith why (toException refusal)
  agreeOn why "said on the registry's errors" said tabled

runFactoryFailure :: Value -> IO ()
runFactoryFailure row = do
  why <- field "a factory-failure case" "why" row
  failing <- field why "failure" row
  code <- field why "transport" failing
  parsed <- maybe (failure why ("fails with " ++ show code ++ ", no code of the transport group")) pure (Code.parseTransportCode code)
  message <- field why "message" failing
  tabled <- tabledSaid why row
  said <- refusedWith why (toException (TransportError parsed message Nothing Nothing))
  agreeOn why "said on the registry's errors" said tabled

-- | kb-a's session is active, and kb-b is activated once the registry's close has returned, or while its close waits
-- for kb-a's client to write the save it owes, from within that write and from this thread while it is held.
runClosed :: Map.Map Text Value -> Value -> IO ()
runClosed fixtures row = do
  why <- field "a closed case" "why" row
  while <- field why "while" row :: IO Text
  closing <- case while of
    "closed" -> pure False
    "closing" -> pure True
    _ -> failure why ("activates while " ++ show while ++ ", which the table does not name")
  person <- fixture fixtures "UserResponse"
  doubles <- newDoubles False
  steps <- newTVarIO []
  outcomes <- newTVarIO []
  made <- newEmptyTMVarIO
  held <- newEmptyTMVarIO
  released <- newEmptyTMVarIO
  let activateNext = do
        browser <- atomically (readTMVar made)
        outcome <- try (Browser.setActiveKb browser (Just "kb-b")) :: IO (Either BusRequestError ())
        atomically (modifyTVar' outcomes (<> [either (Just . busRequestErrorCode) (const Nothing) outcome]))
      -- The owed save is written, and nothing refused; while the registry is closing, the write is held open, and an
      -- activation begun from within it.
      written key = when (key == owedSave person) $ do
        atomically (modifyTVar' steps (<> [wroteTheOwedSave]))
        when closing $ do
          activateNext
          atomically (putTMVar held ())
          atomically (readTMVar released)
      factoryFor http = recording steps <$> factoryOf why doubles http person [] written
  atTheStage doubles unsaved factoryFor saidOf $ \time browser store reader said -> do
    atomically (putTMVar made browser)
    first <- activeOf browser
    if closing
      then do
        owing why time first
        withAsync (Browser.dispose browser) $ \disposal -> do
          atomically (readTMVar held)
          activateNext
          atomically (putTMVar released ())
          wait disposal
      else Browser.dispose browser >> activateNext
    wait reader
    readTVarIO outcomes >>= asTabled why "each activation refused at the call"
      (replicate (if closing then 2 else 1) (Just Code.BusRequestClosed))
    let asked = askedFor "kb-a" : [wroteTheOwedSave | closing]
    readTVarIO steps >>= asTabled why "what the factory and the storage were asked, in order" asked
    readTVarIO said >>= asTabled why "said on the registry's errors" []
    Storage.get store Browser.activeKey >>= asTabled why "the storage's active key" (Just "kb-a")
    Browser.dispose browser
    readTVarIO steps >>= asTabled why "what the factory and the storage were asked once the registry closed again" asked

-- | The factory made for the stage, but for kb-b's sessions, which openKbB opens, handed the factory made for the stage.
asksForKbB :: Text -> Doubles -> Http.HttpOptions -> UserResponse
  -> (Factory.SessionFactory -> Factory.SessionFactoryOptions -> IO Session.OpenedSession) -> IO Factory.SessionFactory
asksForKbB why doubles http person openKbB = do
  built <- factoryOf why doubles http person [] (const (pure ()))
  pure built
    { Factory.openSession = \inputs -> if knowledgeBaseId (Factory.sessionFactoryOptionsKb inputs) == "kb-b"
        then openKbB built inputs
        else Factory.openSession built inputs
    }

-- | kb-a's session is active, and kb-b is activated over a factory that holds the call until it is released, and the
-- registry is closed while it is held: the close tells the call to stop, and returns. A factory that stops when told
-- to hands back nothing; one that does not hands back a session once the close has told it to stop, which the
-- registry closes at once. Released, the activation, taken before the close began, has ended as an overtaken one
-- does: its call returns, nothing is said, and no session is active.
runTakenBeforeTheClose :: Map.Map Text Value -> Bool -> IO ()
runTakenBeforeTheClose fixtures stops = do
  let why = if stops
        then "an activation taken before the registry's close began, its factory stopping when the close tells it to, returns"
        else "an activation taken before the registry's close began, its factory handing a session back once told to stop, returns"
  person <- fixture fixtures "UserResponse"
  doubles <- newDoubles False
  asked <- newEmptyTMVarIO
  released <- newEmptyTMVarIO
  closes <- newTVarIO (0 :: Int)
  let held = atomically (putTMVar asked ()) >> atomically (readTMVar released)
      openKbB built inputs = do
        if stops then held else void (try held :: IO (Either AsyncCancelled ()))
        Session.OpenedSession session close <- Factory.openSession built inputs
        pure (Session.OpenedSession session (atomically (modifyTVar' closes (+ 1)) >> close))
  atTheStage doubles Timing.protocolSettings (\http -> asksForKbB why doubles http person openKbB) saidOf $ \_ browser _ reader said -> do
    _ <- activeOf browser
    withAsync (try (Browser.setActiveKb browser (Just "kb-b")) :: IO (Either BusRequestError ())) $ \activation -> do
      atomically (readTMVar asked)
      Browser.dispose browser
      atomically (putTMVar released ())
      wait activation >>= either (\refusal -> failure why ("raised " ++ show refusal ++ " from the call")) pure
    wait reader
    readTVarIO said >>= asTabled why "said on the registry's errors" []
    readTVarIO closes >>= asTabled why "closes of a session the factory handed back" (if stops then 0 else 1)
    active <- atomically (State.current (Browser.activeSession browser))
    when (isJust active) (failure why "has a session active once it closed")

-- | kb-a's session is active, and kb-b's activation's call to the factory closes the registry: the close returns there,
-- and then stops the call it was made from. The activation returns, nothing is said, and no session is active.
runClosedFromTheFactory :: Map.Map Text Value -> IO ()
runClosedFromTheFactory fixtures = do
  let why = "a registry closed from within its factory returns there, and the activation the call was for returns"
  person <- fixture fixtures "UserResponse"
  doubles <- newDoubles False
  made <- newEmptyTMVarIO
  closedThere <- newEmptyTMVarIO
  never <- newEmptyTMVarIO
  let openKbB built inputs = do
        browser <- atomically (readTMVar made)
        -- What the close did is told before the close can stop this call.
        outcome <- mask_ $ do
          closing <- try (Browser.dispose browser) :: IO (Either SomeException ())
          atomically (putTMVar closedThere closing)
          pure closing
        either throwIO pure outcome
        atomically (readTMVar never)
        Factory.openSession built inputs
  atTheStage doubles Timing.protocolSettings (\http -> asksForKbB why doubles http person openKbB) saidOf $ \_ browser _ reader said -> do
    atomically (putTMVar made browser)
    _ <- activeOf browser
    activated <- try (Browser.setActiveKb browser (Just "kb-b")) :: IO (Either BusRequestError ())
    either (\refusal -> failure why ("raised " ++ show refusal ++ " from the call")) pure activated
    atomically (readTMVar closedThere) >>= either (\problem -> failure why ("raised " ++ show problem ++ " from the close")) pure
    wait reader
    atomically (putTMVar never ())
    readTVarIO said >>= asTabled why "said on the registry's errors" []
    active <- atomically (State.current (Browser.activeSession browser))
    when (isJust active) (failure why "has a session active once it closed")

-- | What a session says when the storage refuses the save its client owes: what the storage said, as it said it, and
-- nothing GHC attached to it as it was thrown, a backtrace among it.
refusedSave :: Text
refusedSave = "The storage refused a write of what the client keeps: user error (" <> Text.pack storageRefusal <> ")"

storageRefusal :: String
storageRefusal = "the storage refuses every write"

-- | The refusal of a switching row's next session; Nothing when it is built.
refusalOfNext :: Text -> Value -> IO (Maybe SessionError)
refusalOfNext _ (String "built") = pure Nothing
refusalOfNext why next@(Object _) = Just <$> own why "kb-b" next
refusalOfNext why next = failure why ("has a next session that is " ++ show next ++ ", which the table does not name")

-- | kb-a's session is active, its client owing a save still waiting out its debounce, to a storage that writes it or
-- refuses every write kb-a's client makes, and kb-b is activated.
runSwitching :: Map.Map Text Value -> Value -> IO ()
runSwitching fixtures row = do
  why <- field "a switching case" "why" row
  storageIs <- field why "storage" row :: IO Text
  refuses <- case storageIs of
    "writes" -> pure False
    "refuses" -> pure True
    _ -> failure why ("has a storage that " ++ show storageIs ++ ", which the table does not name")
  next <- field why "next" row >>= refusalOfNext why
  tabled <- field why "registryErrors" row :: IO [Text]
  active <- field why "active" row :: IO Bool
  person <- fixture fixtures "UserResponse"
  doubles <- newDoubles False
  steps <- newTVarIO []
  let written key = do
        when (key == owedSave person) (atomically (modifyTVar' steps (<> [wroteTheOwedSave])))
        when (refuses && Set.member key (firstClientsKeys person)) (ioError (userError storageRefusal))
      factoryFor http = do
        built <- factoryOf why doubles http person [] written
        pure (recording steps built
          { Factory.openSession = \inputs -> case next of
              Just refusal | knowledgeBaseId (Factory.sessionFactoryOptionsKb inputs) == "kb-b" -> throwIO refusal
              _ -> Factory.openSession built inputs
          })
  atTheStage doubles unsaved factoryFor saidOf $ \time browser store reader said -> do
    activeOf browser >>= owing why time
    Browser.setActiveKb browser (Just "kb-b")
    -- The first session ended, its owed save written once, by its closing flush, before the next was asked for.
    readTVarIO steps >>= asTabled why "what the factory and the storage were asked, in order"
      [askedFor "kb-a", wroteTheOwedSave, askedFor "kb-b"]
    activeNow <- isJust <$> atomically (State.current (Browser.activeSession browser))
    agreeOn why "a session is active" activeNow active
    Storage.get store Browser.activeKey >>= asTabled why "the storage's active key" (Just "kb-b")
    -- The next session's client owes nothing and keeps in what writes, so the registry's close says nothing: what the
    -- reader heard to their end is what was said once the activation returned.
    Browser.dispose browser
    wait reader
    found <- readTVarIO said
    asTabled why "said on the registry's errors" tabled (map fst found)
    forM_ [message | (code, message) <- found, code == Code.sessionCode Code.SessionSaveRefused] $
      asTabled why "what a refused save said" refusedSave

-- | Each of a table's sections, run by the runner of its name; a section no runner is named for fails.
sections :: Text -> [(Text, Value -> IO ())] -> Value -> IO Int
sections table runners (Object members) = do
  counts <- mapM run [(Key.toText name, rows) | (name, Array rows) <- KM.toList members]
  pure (sum counts)
  where
    run (name, rows) = case lookup name runners of
      Just runner -> mapM_ runner rows >> pure (length rows)
      Nothing -> ioError (userError (Text.unpack table ++ " has a section " ++ show name ++ " no runner is named for"))
sections table _ _ = ioError (userError (Text.unpack table ++ " is no object"))

registryActivationCases :: FilePath -> Map.Map Text Value -> IO ()
registryActivationCases root fixtures = do
  let load name = Bytes.readFile (root </> Text.unpack name) >>= either (ioError . userError) pure . eitherDecodeStrict'
      activationTable = "protocol/specs/src/session/registry-activation-cases.json"
      factoryFailureTable = "protocol/specs/src/session/registry-factory-failure-cases.json"
  activation <- load activationTable
  factoryFailure <- load factoryFailureTable
  outcome <- timeout 60000000 $ (,)
    <$> sections activationTable [("refused", runRefused), ("closed", runClosed fixtures), ("switching", runSwitching fixtures)] activation
    <*> sections factoryFailureTable [("cases", runFactoryFailure)] factoryFailure
    <* runTakenBeforeTheClose fixtures True <* runTakenBeforeTheClose fixtures False <* runClosedFromTheFactory fixtures
  (activated, failed) <- maybe (ioError (userError "the registry-activation cases did not finish in a minute")) pure outcome
  forM_ [(activated, activationTable), (failed, factoryFailureTable)] $ \(count, table) ->
    when (count == 0) (ioError (userError (Text.unpack table ++ " has no rows")))
  putStrLn ("PASS " ++ show activated ++ " shared registry-activation cases, " ++ show failed
    ++ " of a factory that fails with something not one of the session's own errors, an activation taken before the"
    ++ " registry's close began, and a close from within the factory")
