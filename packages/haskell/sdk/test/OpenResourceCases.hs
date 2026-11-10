{-# LANGUAGE OverloadedStrings #-}
-- | protocol/specs/src/session/open-resource-cases.json: a registry whose knowledge base's sessions are scripted
-- becomes active with the case's resources open, asks the knowledge base who it is and about each of them, and closes
-- only those it says are gone. A request the knowledge base does not answer fails, as a fault, which is no verdict.
module OpenResourceCases (openResourceCases) where

import Control.Concurrent.STM
import Control.Exception (bracket, throwIO)
import Control.Monad (forM, unless)
import Data.Aeson (FromJSON, Object, Value(..), eitherDecodeStrict', encode, fromJSON, object, Result(..), (.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Lazy as Lazy
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (decodeUtf8, encodeUtf8)
import qualified Data.UUID.Types as UUID
import Network.HTTP.Client (defaultManagerSettings, noProxy)
import qualified ControlledTime as Time
import SessionCases (jwt)
import qualified Semiont.Bus as Bus
import qualified Semiont.Content as Content
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (TransportError(..))
import qualified Semiont.Http as Http
import qualified Semiont.Registry as Browser
import Semiont.Retry (RetryOptions(..))
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.StateValue as State
import qualified Semiont.Testing.Sessions as Sessions
import qualified Semiont.Testing.Transport as Faulty
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types
import System.FilePath ((</>))
import System.Timeout (timeout)

failure :: Text -> String -> IO result
failure why message = ioError (userError ("open-resource case " ++ show why ++ ": " ++ message))

field :: FromJSON value => Text -> Text -> Value -> IO value
field why name (Object fields) = case KM.lookup (Key.fromText name) fields of
  Just value | Success parsed <- fromJSON value -> pure parsed
  _ -> failure why ("states no " ++ Text.unpack name ++ " of its kind")
field why _ _ = failure why "is no object"

fixture :: FromJSON result => Map.Map Text Value -> Text -> IO result
fixture fixtures name = case Map.lookup name fixtures of
  Just value | Success parsed <- fromJSON value -> pure parsed
  _ -> ioError (userError ("no " ++ Text.unpack name ++ " fixture for the open-resource cases"))

-- | The ids as a set: what each case states is compared so.
agree :: Text -> String -> [Text] -> [Text] -> IO ()
agree why what got want = unless (Set.fromList got == Set.fromList want)
  (failure why (what ++ " " ++ show (Set.toList (Set.fromList got)) ++ ", not " ++ show (Set.toList (Set.fromList want))))

kbId, kbDomain :: Text
kbId = "open-resource-cases"
kbDomain = "open.example.test"

resourceOf :: Text -> Object -> IO Text
resourceOf why payload = case KM.lookup "resourceId" payload of
  Just (String resource) -> pure resource
  _ -> failure why "was asked for a resource by no id"

-- | The resources stored as open in the knowledge base.
storedOpen :: Text -> Storage.SessionStorage -> IO [Text]
storedOpen why store = do
  raw <- Storage.get store Browser.openResourcesByKbKey
  case raw >>= either (const Nothing) Just . eitherDecodeStrict' . encodeUtf8 of
    Just (Object documents) -> case KM.lookup (Key.fromText kbId) documents of
      Nothing -> pure []
      Just value | Success tabs <- fromJSON value -> pure (map (resourceIdValue . openResourceId) tabs)
      Just _ -> failure why "stored as open what are not open resources"
    _ -> failure why "stored no document of open resources"

runCase :: Map.Map Text Value -> Value -> IO ()
runCase fixtures row = do
  why <- field "a case" "why" row
  kbAnswer <- field why "kb" row :: IO Text
  open <- field why "open" row :: IO [Text]
  answers <- field why "resources" row :: IO (Map.Map Text Text)
  asked <- field why "asked" row :: IO [Text]
  stillOpen <- field why "stillOpen" row :: IO [Text]
  unless (kbAnswer `elem` ["itself", "unanswered"]) (failure why ("has the knowledge base answer " ++ show kbAnswer ++ ", which the table does not name"))
  unless (all (`elem` ["ready", "gone", "unanswered"]) (Map.elems answers)) (failure why "answers a resource as the table does not name")
  time <- Time.newTime
  ids <- newTVarIO (0 :: Integer)
  let fresh = atomically (modifyTVar' ids (+1) >> readTVar ids)
      clock = RetryOptions (Time.now time) (Time.waitUntil time) (pure 0)
      busOptions = Bus.BusOptions (Time.now time) (Time.waitUntil time) (Text.pack . show <$> fresh)
      unanswered name = throwIO (TransportError Code.TransportError ("the knowledge base does not answer " <> name) Nothing Nothing)
      respond _ name payload = case name of
        "browse:kb-requested"
          | kbAnswer == "itself" -> pure (Just (object ["name" .= ("Open" :: Text), "domain" .= kbDomain]))
          | otherwise -> unanswered name
        "browse:resource-requested" -> do
          resource <- resourceOf why payload
          case Map.lookup resource answers of
            Just "ready" -> pure (Just (object
              [ "resource" .= object ["@context" .= ("https://schema.org/" :: Text), "@id" .= resource, "name" .= resource, "representations" .= ([] :: [Value])]
              , "lastSequence" .= (1 :: Integer) ]))
            Just "unanswered" -> unanswered name
            _ -> failure why ("was asked for " ++ Text.unpack resource ++ ", which it gives no answer about")
        _ -> Faulty.refuseUnscriptedOperation name payload
      gone _ name payload
        | name /= "browse:resource-requested" = pure Nothing
        | otherwise = do
            resource <- resourceOf why payload
            pure (if Map.lookup resource answers == Just "gone"
              then Just (KM.fromList [("message", String (resource <> " is gone")), ("code", String "not-found")]) else Nothing)
      unexpected :: IO result
      unexpected = failure why "read content"
      contents _ = pure (Content.ContentTransport (\_ _ _ _ -> unexpected) (\_ _ -> unexpected) (\_ _ _ -> unexpected)
        (\_ _ -> unexpected) (\_ _ -> unexpected) (\_ _ -> unexpected) (pure ()), Nothing)
  scripted <- Sessions.newScriptedSessions clock busOptions Timing.protocolSettings (pure 1800000000) respond contents
  Sessions.refuseWhen scripted gone
  fixture fixtures "UserResponse" >>= Sessions.saysWho scripted . Just
  grant <- fixture fixtures "StoredSession"
  store <- Storage.newMemoryStorage
  Browser.saveKnowledgeBases store
    [KnowledgeBase ("did:web:" <> kbDomain) (KbEndpointBranch2 (LocalEndpoint kbId LocalEndpointKindLocal mempty)) kbId "Open" Nothing mempty]
  Browser.storeSession store kbId grant { storedSessionAccess = jwt 3600 1 }
  tabs <- forM (zip [0 ..] open) $ \(order, resource) -> do
    identity <- either (failure why) pure (mkResourceId resource)
    pure (OpenResource identity Nothing resource 1800000000000 order Nothing mempty)
  Storage.set store Browser.openResourcesByKbKey (decodeUtf8 (Lazy.toStrict (encode (object [Key.fromText kbId .= tabs]))))
  pool <- Http.newHttpClient noProxy defaultManagerSettings
  let http = Http.HttpOptions "http://unused.test:1" pool (pure Nothing) (const (pure Nothing)) clock Timing.protocolSettings
        (UUID.fromWords 0 0 0 . fromInteger <$> fresh) Set.empty (pure Map.empty) (\_ _ -> pure ())
  bracket (Browser.newSemiontBrowser (Browser.SemiontBrowserConfig store (Sessions.factory scripted) http (pure 1800000000))) Browser.dispose $ \browser -> do
    Time.settle
    requests <- Sessions.transports scripted kbId >>= fmap concat . mapM Faulty.requestLog
    askedAbout <- forM [entry | entry <- requests, Faulty.requestLogEntryChannel entry == "browse:resource-requested"]
      (resourceOf why . Faulty.requestLogEntryPayload)
    held <- map (resourceIdValue . openResourceId) <$> atomically (State.current (Browser.openResources browser))
    agree why "asked about" askedAbout asked
    agree why "kept open" held stillOpen
    storedOpen why store >>= \stored -> agree why "stored as open" stored stillOpen

openResourceCases :: FilePath -> Map.Map Text Value -> IO ()
openResourceCases root fixtures = do
  table <- Bytes.readFile (root </> "protocol/specs/src/session/open-resource-cases.json")
    >>= either (ioError . userError) pure . eitherDecodeStrict'
  cases <- field "the open-resource table" "cases" table :: IO [Value]
  outcome <- timeout 20000000 (mapM_ (runCase fixtures) cases)
  maybe (ioError (userError "the open-resource cases did not finish in twenty seconds")) pure outcome
  putStrLn ("PASS " ++ show (length cases) ++ " shared open-resource cases")
