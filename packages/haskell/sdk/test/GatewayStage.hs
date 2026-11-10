{-# LANGUAGE OverloadedStrings #-}
-- | A stand-in gateway and the issuer it trusts, over real http-client connections. The gateway says who a token is,
-- holds streams, and answers on every stream a request to describe the knowledge base and a request for a resource,
-- naming it fresh, as it answers a stream that names the request pending; the issuer grants what it is told to.
module GatewayStage (Stage(..), newStage, stageHttp, registered, signInOf, send, resumedFrom, resumedWith) where

import Control.Concurrent.STM
import Control.Monad (forM_)
import Data.Aeson (Value(..), object, (.=), eitherDecodeStrict', encode)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Char8 as Char8
import qualified Data.ByteString.Lazy as Lazy
import Data.Char (toLower)
import Data.Foldable (toList)
import qualified Data.Map.Strict as Map
import Data.Maybe (listToMaybe, mapMaybe)
import qualified Data.Set as Set
import Data.Text (Text)
import Data.Text.Encoding (decodeUtf8, encodeUtf8)
import qualified Data.UUID.Types as UUID
import Data.Word (Word32)
import qualified ControlledTime as Time
import IssuerCases (streamingPeer, jsonReply, route, bodyOf)
import qualified Semiont.Channels as Channels
import qualified Semiont.Http as Http
import Semiont.Retry (RetryOptions(..))
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types

data Stage = Stage
  { stageWho :: TVar (Maybe Value)
  -- ^ What the gateway says every token is; Nothing gives no answer, the connection closed.
  , stageWhoHeld :: TVar Bool
  -- ^ While True, every answer of who a token is waits.
  , stageRefusesWho :: TVar (Set.Set Text)
  -- ^ The tokens the gateway refuses to say who they are.
  , stageGrants :: TVar [(Text, Text)]
  -- ^ The access and refresh tokens the issuer grants next, one pair each.
  , stageAskedWho :: TVar [Text]
  -- ^ Every token the gateway was asked who it is.
  , stageSubscriptions :: TVar [Value]
  -- ^ Every stream asked for.
  , stageStreams :: TVar [Bytes.ByteString -> STM ()]
  , stageReplies :: TVar (Map.Map Text Bytes.ByteString)
  -- ^ Every reply sent, by its correlation id.
  , stageStrays :: TVar [Bytes.ByteString]
  -- ^ Every request the stage has no answer for.
  }

newStage :: IO Stage
newStage = atomically $ Stage <$> newTVar Nothing <*> newTVar False <*> newTVar Set.empty <*> newTVar [] <*> newTVar []
  <*> newTVar [] <*> newTVar [] <*> newTVar Map.empty <*> newTVar []

-- | What reaches the stage: every request answered by it, the clock the controlled one, and the stream's global
-- channels the bus's. A session or the registry's factory replaces the token reader, the renewer and the base.
stageHttp :: Stage -> Time.ControlledTime -> Timing.Settings -> IO Http.HttpOptions
stageHttp stage time timing = do
  connections <- streamingPeer (answer stage)
  ids <- newTVarIO (0 :: Word32)
  pure (Http.HttpOptions "http://unused.test:1" connections
    (ioError (userError "the stage's token reader was not replaced"))
    (const (ioError (userError "the stage's renewer was not replaced")))
    (RetryOptions (Time.now time) (Time.waitUntil time) (pure 0)) timing
    (UUID.fromWords 0 0 0 <$> atomically (modifyTVar' ids (+1) >> readTVar ids))
    (Set.fromList Channels.globalChannels) (pure Map.empty) (\_ _ -> pure ()))

-- | A knowledge base at the stage's gateway, whose did the gateway's description of it makes.
registered :: Text -> KnowledgeBase
registered key = KnowledgeBase ("did:web:" <> domainOf key)
  (KbEndpointBranch1 (HttpEndpoint "gateway.test" HttpEndpointKindHttp 80 HttpEndpointProtocolHttp KM.empty)) key key Nothing mempty

domainOf :: Text -> Text
domainOf key = key <> ".example.test"

-- | A sign-in of the stage's issuer, naming the person whose key is given, or nobody.
signInOf :: Text -> Text -> Text -> Maybe Text -> StoredSession
signInOf clientId access refresh person =
  StoredSession access clientId person refresh (Just "http://issuer.test/revoke") "http://issuer.test/token" KM.empty

answer :: Stage -> Bytes.ByteString -> (Bytes.ByteString -> STM ()) -> STM () -> IO ()
answer stage request write hangUp = case Char8.takeWhile (/= '?') (route request) of
  "/api/users/me" -> do
    refused <- atomically $ do
      modifyTVar' (stageAskedWho stage) (<> [token])
      Set.member token <$> readTVar (stageRefusesWho stage)
    atomically $ if refused then write (jsonReply 401 (object ["error" .= String "Invalid token"])) else do
      readTVar (stageWhoHeld stage) >>= check . not
      readTVar (stageWho stage) >>= maybe hangUp (write . jsonReply 200)
  "/token" -> atomically $ readTVar (stageGrants stage) >>= \granting -> case granting of
    [] -> write (jsonReply 400 (object ["error" .= String "invalid_grant"]))
    (access, refresh) : rest -> do
      writeTVar (stageGrants stage) rest
      write (jsonReply 200 (object ["access_token" .= access, "refresh_token" .= refresh, "token_type" .= String "Bearer"
        , "expires_in" .= (3600 :: Int)]))
  "/revoke" -> atomically (write (jsonReply 200 (object [])))
  "/bus/subscribe" | Right subscription <- decoded -> atomically $ do
    modifyTVar' (stageSubscriptions stage) (<> [subscription])
    modifyTVar' (stageStreams stage) (<> [write])
    write "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
    retained <- readTVar (stageReplies stage)
    forM_ (texts "pendingReplies" subscription) $ \correlation -> mapM_ write (Map.lookup correlation retained)
  "/bus/emit" | Right emitted <- decoded -> atomically $ do
    forM_ (replyTo emitted) $ \(correlation, frame) -> do
      let event = sse Nothing frame
      modifyTVar' (stageReplies stage) (Map.insert correlation event)
      readTVar (stageStreams stage) >>= mapM_ ($ event)
    write (jsonReply 202 (object ["subscribers" .= (1 :: Int)]))
  _ -> atomically $ do
    modifyTVar' (stageStrays stage) (<> [request])
    write (jsonReply 404 (object ["error" .= String "the stage has no answer for this"]))
  where
    decoded = eitherDecodeStrict' (bodyOf request) :: Either String Value
    token = maybe "" decodeUtf8 $ listToMaybe
      [ bearer
      | line <- Char8.lines (fst (Bytes.breakSubstring "\r\n\r\n" request))
      , let (name, rest) = Char8.break (== ':') line
      , Char8.map toLower name == "authorization"
      , Just bearer <- [Bytes.stripPrefix "Bearer " (Char8.strip (Bytes.drop 1 rest))]
      ]
    replyTo (Object emitted) = case (KM.lookup "correlationId" emitted, KM.lookup "channel" emitted, KM.lookup "payload" emitted) of
      (Just (String correlation), Just (String "browse:kb-requested"), _) -> Just (correlation, frameOf "browse:kb-result" correlation
        (object ["name" .= String "KB A", "domain" .= domainOf "kb-a"]))
      (Just (String correlation), Just (String "browse:resource-requested"), Just (Object payload)) -> do
        resource <- KM.lookup "resourceId" payload
        Just (correlation, frameOf "browse:resource-result" correlation (object
          [ "resource" .= object ["@context" .= String "https://schema.org", "@id" .= resource, "name" .= String "fresh"
            , "representations" .= ([] :: [Value])]
          , "lastSequence" .= (1 :: Int) ]))
      _ -> Nothing
    replyTo _ = Nothing
    frameOf channel correlation response = object
      ["channel" .= String channel, "correlationId" .= correlation, "payload" .= object ["response" .= response]]

texts :: Key.Key -> Value -> [Text]
texts name (Object fields) | Just (Array items) <- KM.lookup name fields = [text | String text <- toList items]
texts _ _ = []

sse :: Maybe Text -> Value -> Bytes.ByteString
sse identity frame = "event: bus-event\n" <> maybe "" (\value -> "id: " <> encodeUtf8 value <> "\n") identity
  <> "data: " <> Lazy.toStrict (encode frame) <> "\n\n"

-- | Gives every stream a frame, with the event id when there is one.
send :: Stage -> Maybe Text -> Value -> STM ()
send stage identity frame = readTVar (stageStreams stage) >>= mapM_ ($ sse identity frame)

-- | Each scope a stream named, and the place it resumed it from.
scopedOf :: Value -> [(Text, Maybe Text)]
scopedOf (Object subscription) | Just (Array items) <- KM.lookup "scoped" subscription = mapMaybe entry (toList items)
  where
    entry (Object item) | Just (String scope) <- KM.lookup "scope" item = Just (scope, case KM.lookup "lastEventId" item of
      Just (String place) -> Just place
      _ -> Nothing)
    entry _ = Nothing
scopedOf _ = []

-- | The place the first stream that named scope resumed it from, Nothing for none; Nothing while no stream has named
-- it.
resumedFrom :: Stage -> Text -> STM (Maybe (Maybe Text))
resumedFrom stage scope = listToMaybe . mapMaybe (lookup scope . scopedOf) <$> readTVar (stageSubscriptions stage)

-- | The place the first stream that named with resumed scope from, Nothing for none; Nothing while no stream has
-- named with, or the first that did named no scope.
resumedWith :: Stage -> Text -> Text -> STM (Maybe (Maybe Text))
resumedWith stage scope with = do
  subscribed <- map scopedOf <$> readTVar (stageSubscriptions stage)
  pure (case [scoped | scoped <- subscribed, any ((== with) . fst) scoped] of
    scoped : _ -> lookup scope scoped
    [] -> Nothing)
