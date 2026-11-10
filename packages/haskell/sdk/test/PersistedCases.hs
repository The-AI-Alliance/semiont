{-# LANGUAGE OverloadedStrings #-}
-- | protocol/specs/src/session/persisted-cases.json: what a client keeps of one person in a storage, and when it is
-- read, written and deleted.
module PersistedCases (persistedCases) where

import Control.Exception (bracket)
import Control.Monad (forM, forM_, unless, when)
import Data.Aeson (FromJSON, Value(..), eitherDecodeStrict', fromJSON, Result(..))
import qualified Data.Aeson.Decoding.ByteString as Tokens
import Data.Aeson.Decoding.Tokens (Tokens(..), TkArray(..), TkRecord(..))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as Text
import Network.HTTP.Client (defaultManagerSettings, noProxy)
import qualified ControlledTime as Time
import SessionCases (jwt)
import qualified Semiont.Bus as Bus
import qualified Semiont.Content as Content
import qualified Semiont.Http as Http
import Semiont.Internal.Generated.CachePersistence (KeptQuery(..), keptQueryName)
import qualified Semiont.Internal.Kept as Kept
import qualified Semiont.Registry as Browser
import qualified Semiont.Registry.Factory as Factory
import Semiont.Retry (RetryOptions(..))
import qualified Semiont.Session as Session
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.StateValue as State
import qualified Semiont.Testing.Sessions as Sessions
import qualified Semiont.Testing.Transport as Faulty
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types
import qualified Data.UUID.Types as UUID
import Control.Concurrent.STM
import System.FilePath ((</>))
import System.Timeout (timeout)

failure :: Text -> String -> IO result
failure why message = ioError (userError ("persisted case " ++ show why ++ ": " ++ message))

field :: FromJSON value => Text -> Text -> Value -> IO value
field why name (Object fields) = case KM.lookup (Key.fromText name) fields of
  Just value | Success parsed <- fromJSON value -> pure parsed
  _ -> failure why ("states no " ++ Text.unpack name ++ " of its kind")
field why _ _ = failure why "is no object"

fixture :: FromJSON result => Map.Map Text Value -> Text -> IO result
fixture fixtures name = case Map.lookup name fixtures of
  Just value | Success parsed <- fromJSON value -> pure parsed
  _ -> ioError (userError ("no " ++ Text.unpack name ++ " fixture for the persisted cases"))

-- | A JSON value whose objects keep their members in the order its text states them.
data InOrder = Members [(Text, InOrder)] | Items [InOrder] | Scalar

inOrder :: Tokens k String -> Either String (InOrder, k)
inOrder (TkLit _ rest) = Right (Scalar, rest)
inOrder (TkText _ rest) = Right (Scalar, rest)
inOrder (TkNumber _ rest) = Right (Scalar, rest)
inOrder (TkArrayOpen items) = (\(values, rest) -> (Items values, rest)) <$> itemsInOrder items
inOrder (TkRecordOpen members) = (\(values, rest) -> (Members values, rest)) <$> membersInOrder members
inOrder (TkErr problem) = Left problem

itemsInOrder :: TkArray k String -> Either String ([InOrder], k)
itemsInOrder (TkItem item) = do
  (value, rest) <- inOrder item
  (values, end) <- itemsInOrder rest
  pure (value : values, end)
itemsInOrder (TkArrayEnd rest) = Right ([], rest)
itemsInOrder (TkArrayErr problem) = Left problem

membersInOrder :: TkRecord k String -> Either String ([(Text, InOrder)], k)
membersInOrder (TkPair key item) = do
  (value, rest) <- inOrder item
  (values, end) <- membersInOrder rest
  pure ((Key.toText key, value) : values, end)
membersInOrder (TkRecordEnd rest) = Right ([], rest)
membersInOrder (TkRecordErr problem) = Left problem

memberOf :: Text -> InOrder -> IO InOrder
memberOf name (Members members) = maybe (failure "the table" ("states no " ++ Text.unpack name)) pure (lookup name members)
memberOf name _ = failure "the table" ("holds " ++ Text.unpack name ++ " in what is no object")

-- | The table's `keys`: each row's persisted queries are the runner's, in refresh.json's order, and each key, the
-- stream's and every persisted query's, is the one the runner makes; and each person's key is the one their did makes.
keysPart :: Bytes.ByteString -> Value -> IO Int
keysPart text table = do
  ordered <- either (failure "the table" . ("is not JSON: " ++)) (pure . fst) (inOrder (Tokens.bsToTokens text))
  orderedRows <- memberOf "keys" ordered >>= \rows -> case rows of
    Items values -> pure values
    _ -> failure "the table" "states keys that are no list"
  rows <- field "the table" "keys" table :: IO [Value]
  unless (length rows == length orderedRows && not (null rows)) (failure "the table" "states keys this runner did not read")
  forM_ (zip rows orderedRows) $ \(row, orderedRow) -> do
    why <- field "a keys row" "why" row
    kbId <- field why "kbId" row
    did <- field why "did" row
    person <- field why "personKey" row
    lastEventIdKey <- field why "lastEventIdKey" row
    cacheKeys <- field why "cacheKeys" row :: IO (Map.Map Text Text)
    names <- memberOf "cacheKeys" orderedRow >>= \members -> case members of
      Members values -> pure (map fst values)
      _ -> failure why "states cache keys that are no object"
    unless (Kept.personKey did == person) (failure why ("makes the person's key " ++ show (Kept.personKey did)))
    unless (Kept.lastEventIdKey kbId person == lastEventIdKey) (failure why ("makes the places' key " ++ show (Kept.lastEventIdKey kbId person)))
    let queries = [minBound .. maxBound] :: [KeptQuery]
    unless (map keptQueryName queries == names) (failure why ("persists " ++ show (map keptQueryName queries) ++ ", not " ++ show names))
    forM_ queries $ \query -> unless (Map.lookup (keptQueryName query) cacheKeys == Just (Kept.cacheKey kbId person query))
      (failure why ("makes the " ++ Text.unpack (keptQueryName query) ++ " key " ++ show (Kept.cacheKey kbId person query)))
  people <- field "the table" "people" table :: IO (Map.Map Text (Map.Map Text Text))
  forM_ (Map.toList people) $ \(name, person) -> case (Map.lookup "did" person, Map.lookup "personKey" person) of
    (Just did, Just key) -> unless (Kept.personKey did == key) (failure name ("is keyed " ++ show (Kept.personKey did)))
    _ -> failure name "is no did and key"
  pure (length rows)

-- | The key of a person in the table's people.
personOf :: Value -> Text -> IO Text
personOf table name = do
  people <- field "the table" "people" table :: IO (Map.Map Text (Map.Map Text Text))
  maybe (failure "the table" ("names no person " ++ Text.unpack name)) pure (Map.lookup name people >>= Map.lookup "personKey")

-- | The table's `keys` row of a knowledge base and a person.
keyRowOf :: Value -> Text -> Text -> IO Value
keyRowOf table kbId person = do
  rows <- field "the table" "keys" table :: IO [Value]
  found <- forM rows $ \row -> do
    rowKb <- field "a keys row" "kbId" row
    rowPerson <- field "a keys row" "personKey" row
    pure [row | (rowKb, rowPerson) == (kbId :: Text, person)]
  case concat found of
    [row] -> pure row
    _ -> failure "the table" ("states the keys of " ++ Text.unpack person ++ " on " ++ Text.unpack kbId ++ " not once")

-- | Every key the table's `keys` say is kept on a knowledge base for a person: the stream's places, and each
-- persisted query's.
keysOf :: Value -> Text -> Text -> IO [Text]
keysOf table kbId person = do
  row <- keyRowOf table kbId person
  places <- field "a keys row" "lastEventIdKey" row
  caches <- field "a keys row" "cacheKeys" row :: IO (Map.Map Text Text)
  pure (places : Map.elems caches)

-- | The key the table's `keys` say a persisted query is kept under on a knowledge base for a person.
cacheKeyOf :: Value -> Text -> Text -> Text -> IO Text
cacheKeyOf table kbId person query = do
  caches <- keyRowOf table kbId person >>= field "a keys row" "cacheKeys" :: IO (Map.Map Text Text)
  maybe (failure "the table" ("keeps no " ++ Text.unpack query ++ " key")) pure (Map.lookup query caches)

-- | The table's `forgetStorage`, held once kb-a's client has closed to what the row `removes`: every key of the
-- person on kb-a gone, or none, and every other key holding what it held.
leftAsTheRowSays :: Text -> Value -> Text -> Storage.SessionStorage -> Text -> IO ()
leftAsTheRowSays why table removes storage jo = do
  seeded <- field "the table" "forgetStorage" table :: IO (Map.Map Text Text)
  removed <- case removes of
    "person" -> Set.fromList <$> keysOf table "kb-a" jo
    "nothing" -> pure Set.empty
    _ -> failure why ("removes " ++ show removes ++ ", which the table does not name")
  forM_ (Set.toList removed) $ \key -> Storage.get storage key >>= \held ->
    unless (held == Nothing) (failure why (Text.unpack key ++ " holds " ++ show held))
  forM_ (Map.toList seeded) $ \(key, value) -> unless (Set.member key removed) $ Storage.get storage key >>= \held ->
    unless (held == Just value) (failure why (Text.unpack key ++ " holds " ++ show held ++ ", not what it held"))

-- | A stored sign-in of kb-a or kb-b, as the table's rows state it.
grantOf :: StoredSession -> Integer -> Maybe Text -> StoredSession
grantOf base serial person = base
  { storedSessionAccess = jwt 3600 serial, storedSessionRefresh = "refresh-" <> Text.pack (show serial), storedSessionPersonKey = person }

knowledgeBase :: Text -> KnowledgeBase
knowledgeBase key = KnowledgeBase ("did:web:" <> key <> ".example.test") (KbEndpointBranch2 (LocalEndpoint key LocalEndpointKindLocal mempty)) key key Nothing mempty

-- | A row of `forget` the registry performs: signing out of kb-a, removing it, or signing in to it again with a new
-- sign-in, with kb-a and kb-b registered and kb-b active unless kb-a is open. The sessions are scripted, and one of
-- kb-a whose stored sign-in names jo when it is made writes under jo's resource key as it closes, as a client kept for
-- jo closing with a save pending could.
forgottenByTheRegistry :: Map.Map Text Value -> Value -> Text -> Value -> IO ()
forgottenByTheRegistry fixtures table jo row = do
  why <- field "a forget row" "why" row
  by <- field why "by" row :: IO Text
  signedIn <- field why "signedIn" row :: IO Text
  open <- field why "open" row :: IO Bool
  removes <- field why "removes" row :: IO Text
  seeded <- field "the table" "forgetStorage" table :: IO (Map.Map Text Text)
  time <- Time.newTime
  ids <- newTVarIO (0 :: Integer)
  let fresh = atomically (modifyTVar' ids (+1) >> readTVar ids)
      clock = RetryOptions (Time.now time) (Time.waitUntil time) (pure 0)
      busOptions = Bus.BusOptions (Time.now time) (Time.waitUntil time) (Text.pack . show <$> fresh)
      unexpected :: IO result
      unexpected = failure why "read content"
      contents _ = pure (Content.ContentTransport (\_ _ _ _ -> unexpected) (\_ _ -> unexpected) (\_ _ _ -> unexpected)
        (\_ _ -> unexpected) (\_ _ -> unexpected) (\_ _ -> unexpected) (pure ()), Nothing)
  scripted <- Sessions.newScriptedSessions clock busOptions Timing.protocolSettings (pure 1800000000)
    (\_ name payload -> Faulty.refuseUnscriptedOperation name payload) contents
  fixture fixtures "UserResponse" >>= Sessions.saysWho scripted . Just
  base <- fixture fixtures "StoredSession"
  store <- Storage.newMemoryStorage
  mapM_ (uncurry (Storage.set store)) (Map.toList seeded)
  Browser.saveKnowledgeBases store [knowledgeBase "kb-a", knowledgeBase "kb-b"]
  Storage.set store Browser.activeKey (if open then "kb-a" else "kb-b")
  case signedIn of
    "named" -> Browser.storeSession store "kb-a" (grantOf base 1 (Just jo))
    "unnamed" -> Browser.storeSession store "kb-a" (grantOf base 1 Nothing)
    "none" -> pure ()
    _ -> failure why ("is signed in " ++ show signedIn ++ ", which the table does not name")
  Browser.storeSession store "kb-b" (grantOf base 2 Nothing)
  joResource <- cacheKeyOf table "kb-a" jo "resource"
  let Factory.SessionFactory opening revoking = Sessions.factory scripted
      writesAsItCloses inputs = do
        Session.OpenedSession session close <- opening inputs
        kept <- if knowledgeBaseId (Factory.sessionFactoryOptionsKb inputs) == "kb-a" then Browser.storedSession store "kb-a" else pure Nothing
        pure (Session.OpenedSession session (if (kept >>= storedSessionPersonKey) == Just jo
          then close >> Storage.set store joResource "{\"version\":1,\"entries\":[]}" else close))
      renewed = grantOf base 3 Nothing
  pool <- Http.newHttpClient noProxy defaultManagerSettings
  let http = Http.HttpOptions "http://unused.test:1" pool (pure Nothing) (const (pure Nothing)) clock Timing.protocolSettings
        (UUID.fromWords 0 0 0 . fromInteger <$> fresh) Set.empty (pure Map.empty) (\_ _ -> pure ())
      config = Browser.SemiontBrowserConfig store (Factory.SessionFactory writesAsItCloses revoking) http (pure 1800000000)
  bracket (Browser.newSemiontBrowser config) Browser.dispose $ \browser -> do
    Time.settle
    active <- atomically (State.current (Browser.activeKbId browser))
    live <- atomically (State.current (Browser.activeSession browser))
    unless (active == Just (if open then "kb-a" else "kb-b") && maybe False (const True) live)
      (failure why ("is active on " ++ show active ++ " with no session made"))
    case by of
      "signOut" -> Browser.signOut browser "kb-a"
      "removal" -> Browser.removeKb browser "kb-a"
      "signIn" -> Browser.signIn browser "kb-a" renewed
      _ -> failure why ("is forgotten by " ++ show by ++ ", which the registry does not do")
    Time.settle
    leftAsTheRowSays why table removes store jo
    when (by == "signIn") $ Browser.storedSession store "kb-a" >>= \stored ->
      unless (stored == Just renewed) (failure why ("leaves kb-a signed in as " ++ show stored ++ ", not the new sign-in"))

forgetPart :: Map.Map Text Value -> Value -> IO Int
forgetPart fixtures table = do
  jo <- personOf table "jo"
  rows <- field "the table" "forget" table :: IO [Value]
  byTheRegistry <- forM rows $ \row -> do
    by <- field "a forget row" "by" row :: IO Text
    if by `elem` ["signOut", "removal", "signIn"] then forgottenByTheRegistry fixtures table jo row >> pure 1 else pure (0 :: Int)
  pure (sum byTheRegistry)

persistedCases :: FilePath -> Map.Map Text Value -> IO ()
persistedCases root fixtures = do
  text <- Bytes.readFile (root </> "protocol/specs/src/session/persisted-cases.json")
  table <- either (ioError . userError) pure (eitherDecodeStrict' text)
  outcome <- timeout 30000000 $ do
    keyRows <- keysPart text table
    forgetRows <- forgetPart fixtures table
    pure (keyRows + forgetRows)
  ran <- maybe (ioError (userError "the persisted cases did not finish in thirty seconds")) pure outcome
  putStrLn ("PASS " ++ show ran ++ " shared persisted cases")
