{-# LANGUAGE GADTs, OverloadedStrings, ScopedTypeVariables #-}
module Semiont.Internal.Http
  ( Http, HttpClient(..), newHttpClient, HttpOptions(..), newHttp, transport, spawn
  , json, exchange, currentToken, renew, quarantine, jsonBody, deadline, pause, raceOwned, request, refusal, checked, readAnswer
  , options, lifetime, input, positions, clientId, logger, openScoped, HttpFailure(..), report
  ) where

import Control.Concurrent (forkIO, myThreadId, throwTo)
import Control.Concurrent.MVar
import Control.Concurrent.STM
import Control.Concurrent.Async (Async, ExceptionInLinkedThread(..), asyncThreadId, race, cancel, link)
import Control.Exception (Exception, Handler(..), SomeException, bracket, catch, catches, mask, onException, throwIO, try)
import Control.Monad (unless, void, when)
import qualified Semiont.Internal.Required as Required
import Data.Aeson (FromJSON, ToJSON, Result(..), Value(String), eitherDecodeStrict', encode, fromJSON, toJSON)
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Char8 as Char8
import qualified Data.CaseInsensitive as CI
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.UUID.Types (UUID)
import qualified Data.UUID.Types as UUID
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8, decodeUtf8With)
import Data.Text.Encoding.Error (lenientDecode)
import Network.HTTP.Client
import Network.HTTP.Client.Internal (Connection(..), ManagerSettings(managerTlsProxyConnection))
import Network.HTTP.Types (RequestHeaders, statusCode, statusMessage, hAuthorization, hContentType, hRetryAfter)
import Network.URI (parseURI, uriAuthority, uriUserInfo, uriScheme, uriQuery, uriFragment)
import OpenTelemetry.Context.ThreadLocal.Propagation (propagateContext, tracedWithAsync)
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors
import qualified Semiont.Internal.Lifetime as Lifetime
import qualified Semiont.Internal.Telemetry as Telemetry
import qualified Semiont.Internal.BusLog as BusLog
import qualified Semiont.Internal.Transport as Transport
import Semiont.Internal.Generated.Schemas (schemas)
import Semiont.Internal.Schema (validateNamed)
import Semiont.Http.Routes
import qualified Semiont.Retry as Retry
import Semiont.Internal.RetryPolicy (repeatableMethod)
import qualified Semiont.Timing.Settings as Settings
import Semiont.Types

-- A caller builds this pool once. Its settings retain TLS and proxy policy;
-- implicit retries are disabled because Semiont owns the attempt budget.
newtype HttpClient = HttpClient Manager

newHttpClient :: ProxyOverride -> ManagerSettings -> IO HttpClient
newHttpClient proxyPolicy settings = HttpClient <$> newManager proxied
  { managerRetryableException = const False, managerResponseTimeout = responseTimeoutNone
  , managerRawConnection = (\opening address hostName portNumber -> interruptible <$> opening address hostName portNumber)
      <$> managerRawConnection proxied
  , managerTlsConnection = (\opening address hostName portNumber -> interruptible <$> opening address hostName portNumber)
      <$> managerTlsConnection proxied
  , managerTlsProxyConnection = (\opening connectRequest tunnel proxyName address hostName portNumber ->
      interruptible <$> opening connectRequest tunnel proxyName address hostName portNumber) <$> managerTlsProxyConnection proxied }
  where proxied = managerSetProxy proxyPolicy settings

-- On Windows a socket read is a blocking foreign call, and an exception thrown to a thread inside one waits for
-- the call to return, so a deadline or a cancellation would wait on the peer. Each read runs in a thread of its
-- own; an exception to the reader closes the connection, which ends the read.
interruptible :: Connection -> Connection
interruptible connection = connection { connectionRead = do
  chunk <- newEmptyMVar
  _ <- forkIO (try (connectionRead connection) >>= putMVar chunk)
  received <- takeMVar chunk `onException` connectionClose connection
  either (\(problem :: SomeException) -> throwIO problem) pure received }

data HttpOptions = HttpOptions
  { httpBaseUrl :: Text
  , httpClient :: HttpClient
  , httpToken :: IO (Maybe Text)
  , httpRenewToken :: Text -> IO (Maybe Text)
  , httpTime :: Retry.RetryOptions
  , httpTiming :: Settings.Settings
  , httpNewId :: IO UUID
  -- ^ A fresh UUID on each call for routing and idempotency keys.
  , httpGlobalChannels :: Set.Set Text
  , httpLoadPositions :: IO (Map.Map ResourceId Text)
  -- ^ The places kept: read each time the stream opens, for each scope it
  -- holds no place in yet.
  , httpSavePosition :: ResourceId -> Text -> IO ()
  }

data Http = Http
  { options :: HttpOptions
  , transport :: Transport.Transport
  , input :: Transport.TransportInput
  , lifetime :: Lifetime.Lifetime
  , template :: Request
  , replacements :: TVar (Maybe (Text, Maybe Text))
  , refusedTokens :: TVar (Set.Set Text)
  , renewing :: MVar ()
  , clientId :: Text
  , positions :: TVar (Map.Map ResourceId Text)
  , logger :: BusLog.Logger
  }

data EmitCredentialRefused = EmitCredentialRefused HttpFailure Text deriving (Show)
instance Exception EmitCredentialRefused

data HttpFailure = HttpFailure { failure :: TransportError, expired :: Bool } deriving (Show)
instance Exception HttpFailure

newHttp :: HttpOptions -> Set.Set Text -> (Http -> IO ()) -> IO Http
newHttp configuration receives actor = do
  _ <- checked (httpTiming configuration)
  let address = Text.dropWhileEnd (== '/') (httpBaseUrl configuration)
  case parseURI (Text.unpack address) of
    Just uri | uriScheme uri `elem` ["http:", "https:"] && uriQuery uri == "" && uriFragment uri == ""
      && maybe False ((== "") . uriUserInfo) (uriAuthority uri) -> pure ()
    _ -> throwIO (TransportError Code.TransportError "HTTP base URL is not an absolute credential-free HTTP URL" Nothing Nothing)
  base <- parseRequest (Text.unpack address)
  life <- Lifetime.newLifetime "HTTP transport is closed"
  holder <- newEmptyMVar
  let send frame = readMVar holder >>= \http -> emit http frame
  (wire, source) <- Transport.newTransport (Transport.TransportOptions address receives send (Lifetime.close life))
  identity <- UUID.toText <$> httpNewId configuration
  logging <- BusLog.environmentLogger
  http <- Http configuration wire source life base <$> newTVarIO Nothing <*> newTVarIO Set.empty <*> newMVar () <*> pure identity <*> newTVarIO Map.empty <*> pure logging
  putMVar holder http
  void (spawn http (actor http))
  pure http

spawn :: Http -> IO result -> IO (Async result)
spawn http = Lifetime.start (lifetime http) . Transport.ownAction (transport http)

pause :: Http -> Integer -> IO ()
pause http milliseconds = do
  let clock = httpTime (options http)
  now <- Retry.retryNow clock
  Retry.retryWaitUntil clock (now + milliseconds * 1000000)

raceOwned :: Http -> IO left -> IO right -> IO (Either left right)
raceOwned http left right = do
  inheritedLeft <- propagateContext (Transport.ownAction (transport http) left)
  inheritedRight <- propagateContext (Transport.ownAction (transport http) right)
  race inheritedLeft inheritedRight

deadline :: Http -> Integer -> IO value -> IO value
deadline http milliseconds action = do
  let clock = httpTime (options http)
  now <- Retry.retryNow clock
  result <- raceOwned http action (Retry.retryWaitUntil clock (now + milliseconds * 1000000))
  either pure (const (throwIO (HttpFailure (TransportError Code.TransportUnavailable "HTTP request deadline expired" Nothing Nothing) True))) result

candidateToken :: Http -> IO (Maybe Text)
candidateToken http = do
  readToken <- httpToken (options http)
  let supplied = readToken >>= \token -> if Text.null token then Nothing else Just token
  replacement <- readTVarIO (replacements http)
  pure $ case replacement of Just (before, after) | supplied == Just before -> after; _ -> supplied

currentToken :: Http -> IO (Maybe Text)
currentToken http = do
  candidate <- candidateToken http
  refused <- readTVarIO (refusedTokens http)
  pure (candidate >>= \value -> if Set.member value refused then Nothing else Just value)

quarantine :: Http -> Text -> IO ()
quarantine http token = atomically (modifyTVar' (refusedTokens http) (Set.insert token))

renew :: Http -> Text -> IO (Maybe Text)
renew http refused = withMVar (renewing http) $ \() -> do
  actual <- candidateToken http
  if actual /= Just refused then currentToken http else do
    result <- httpRenewToken (options http) refused
    let usable = result >>= \token -> if Text.null token || token == refused then Nothing else Just token
    atomically (writeTVar (replacements http) (Just (refused, usable)))
    currentToken http

request :: Http -> HttpRoute requestBodyType answer -> Maybe ResourceId -> Maybe Text -> RequestBody -> IO Request
request http route resource token body = do
  trace <- Telemetry.outgoingHeaders
  pure $ (template http)
    { method = routeMethod route
    , path = Char8.dropWhileEnd (== '/') (path (template http)) <> encodeUtf8 rendered
    , queryString = ""
    , requestHeaders = [(hContentType, media) | media <- maybe [] pure (routeRequestMediaType route)] ++ [("Accept", routeMediaType route)] ++ [(hAuthorization, "Bearer " <> encodeUtf8 value) | value <- maybe [] pure token] ++ trace
    , requestBody = body
    , responseTimeout = responseTimeoutNone
    , redirectCount = 0
    , cookieJar = Nothing
    , checkResponse = \_ _ -> pure ()
    }
  where
    rendered = Text.replace "{id}" (maybe "" resourceIdValue resource) (routePath route)

checked :: (FromJSON value, ToJSON value) => value -> IO value
checked value = case fromJSON (toJSON value) of
  Error reason -> throwIO (TransportError Code.TransportBadRequest (Text.pack reason) Nothing Nothing)
  Success answer -> pure answer

refusal :: Http -> Response BodyReader -> IO HttpFailure
refusal http response = do
  bodyBytes <- (deadline http (Settings.httpRequestTimeoutMs (httpTiming (options http))) (Bytes.concat <$> brConsume (responseBody response)))
    `catch` (\(_ :: HttpFailure) -> pure Bytes.empty)
    `catch` (\(_ :: HttpException) -> pure Bytes.empty)
  let status = statusCode (responseStatus response)
      parsed = eitherDecodeStrict' bodyBytes :: Either String ErrorResponse
      credential = wireRefusesCredential status (either (const Nothing) Just (eitherDecodeStrict' bodyBytes))
      message = "HTTP " <> Text.pack (show status) <> " " <> decodeUtf8With lenientDecode (statusMessage (responseStatus response))
        <> either (const "") ((": " <>) . errorResponseError) parsed
      retryAfter = Retry.retryAfterMs (decodeUtf8With lenientDecode <$> lookup hRetryAfter (responseHeaders response))
  pure (HttpFailure (TransportError (if credential then Code.TransportUnauthorized else Code.transportCodeFromStatus status) message (Just status) retryAfter) False)

open :: Http -> Request -> IO (Response BodyReader)
open http asked = let HttpClient manager = httpClient (options http) in
  responseOpen asked manager `catch` (\(_ :: HttpException) -> throwIO (HttpFailure
    (TransportError Code.TransportUnavailable "HTTP request got no answer" Nothing Nothing) False))

-- The callback stays inside the response scope, including through a renewal.
exchange :: Http -> HttpRoute requestBodyType answer -> Maybe ResourceId -> IO RequestBody -> Maybe Text
  -> Maybe Text -> RequestHeaders -> (Response BodyReader -> IO value) -> IO value
exchange http route resource body key override headers consume = do
  requiredHeaders <- case (routeRequiredHeaders route, key) of
    ([], Nothing) -> pure []
    ([(name, named)], Just value) -> case validateNamed schemas named (String value) of
      Right () -> pure [(CI.mk name, encodeUtf8 value)]
      Left _ -> throwIO (HttpFailure (TransportError Code.TransportBadRequest "Invalid HTTP key header" Nothing Nothing) False)
    _ -> throwIO (HttpFailure (TransportError Code.TransportBadRequest "HTTP required headers were not supplied" Nothing Nothing) False)
  renewed <- newTVarIO False
  let attempt retries = do
        sent <- if routeAuthenticated route then maybe (currentToken http) (pure . Just) override else pure Nothing
        when (routeAuthenticated route && sent == Nothing)
          (throwIO (HttpFailure (TransportError Code.TransportUnauthorized "No usable credential" (Just 401) Nothing) False))
        fresh <- body
        base <- request http route resource sent fresh
        let asked = base { requestHeaders = filter (\(name, _) -> name `notElem` map fst headers) (requestHeaders base) ++ headers
              ++ requiredHeaders }
            consumeAnswer response =
              if statusCode (responseStatus response) == routeStatus route then Right <$> consume response
              else Left <$> refusal http response
            one = case route of
              GetResourceRepresentation -> openScoped http (Settings.httpRequestTimeoutMs (httpTiming (options http))) asked consumeAnswer
              EmitOnBus -> openScoped http (Settings.emitTimeoutMs (httpTiming (options http))) asked consumeAnswer
              _ -> bracket (open http asked) responseClose consumeAnswer
        let bounded = case route of
              UploadResource -> one
              GetResourceRepresentation -> one
              EmitOnBus -> one
              _ -> deadline http (Settings.httpRequestTimeoutMs (httpTiming (options http))) one
        outcome <- try bounded
        case either Left id outcome of
          Right answer -> pure answer
          Left problem -> do
            let problemError = failure problem
            when (override==Nothing && transportErrorCode problemError == Code.TransportUnauthorized) (mapM_ (quarantine http) sent)
            alreadyRenewed <- readTVarIO renewed
            if override==Nothing && transportErrorCode problemError == Code.TransportUnauthorized && not alreadyRenewed then case sent of
              Just refused -> do
                case route of
                  EmitOnBus -> throwIO (EmitCredentialRefused problem refused)
                  _ -> do
                    atomically (writeTVar renewed True)
                    replacement <- renew http refused
                    if replacement /= Nothing then attempt retries else throwIO problem
              Nothing -> throwIO problem
            else if override==Nothing && (case route of EmitOnBus -> False; _ -> True) && retries == (0 :: Int) && not (expired problem)
                && transportErrorCode problemError /= Code.TransportUnauthorized
                && (Retry.retryable Retry.Transport (httpStatus problemError) (Just (decodeUtf8With lenientDecode (routeMethod route))) (key /= Nothing)
                  || (httpStatus problemError == Nothing && (key /= Nothing || repeatableMethod (decodeUtf8With lenientDecode (routeMethod route))))) then do
              pause http (max (Settings.requestRetryPauseMs (httpTiming (options http))) (maybe 0 id (retryAfterMs problemError)))
              attempt 1
            else throwIO problem
      emitBudget = Retry.retryWithBackoff (httpTime (options http)) (Settings.emitRetry (httpTiming (options http)))
        accepts (retryAfterMs . failure) (attempt 0)
  case route of
    EmitOnBus -> emitBudget `catch` \(EmitCredentialRefused problem refused) -> do
      atomically (writeTVar renewed True)
      replacement <- renew http refused
      if replacement == Nothing then throwIO problem else emitBudget
    _ -> attempt 0
  where
    accepts problem = let problemError = failure problem in
      ((httpStatus problemError == Nothing && transportErrorCode problemError == Code.TransportUnavailable) || Retry.retryable Retry.Boot (httpStatus problemError) Nothing False)
        && transportErrorCode problemError /= Code.TransportUnauthorized

openScoped :: Http -> Integer -> Request -> (Response BodyReader -> IO value) -> IO value
openScoped http milliseconds asked consume = mask $ \restore -> do
  caller <- myThreadId
  answered <- newEmptyTMVarIO
  clockNow <- Retry.retryNow (httpTime (options http))
  let timer = Transport.ownAction (transport http) $ do
        Retry.retryWaitUntil (httpTime (options http)) (clockNow + milliseconds * 1000000)
        won <- atomically (tryPutTMVar answered False)
        when won (throwTo caller (HttpFailure (TransportError Code.TransportUnavailable "HTTP headers deadline expired" Nothing Nothing) True))
  tracedWithAsync timer $ \watcher ->
    (do
      link watcher
      bracket (restore (open http asked)) responseClose $ \response -> do
        won <- atomically (tryPutTMVar answered True)
        cancel watcher
        unless won (throwIO (HttpFailure (TransportError Code.TransportUnavailable "HTTP headers deadline expired" Nothing Nothing) True))
        restore (consume response))
    `catch` \problem@(ExceptionInLinkedThread source exception) ->
      if asyncThreadId source == asyncThreadId watcher then throwIO exception else throwIO problem

report :: Http -> IO value -> IO value
report http action = Lifetime.run (lifetime http) (Transport.ownAction (transport http) action)
  `catches`
    [ Handler (\problem -> Transport.raiseTransportError (transport http) (failure problem))
    , Handler (\(_ :: HttpException) -> Transport.raiseTransportError (transport http)
        (TransportError Code.TransportUnavailable "HTTP response could not be read" Nothing Nothing))
    , Handler (Transport.raiseTransportError (transport http))
    ]

jsonBody :: ToJSON requestBodyType => HttpRoute requestBodyType answer -> requestBodyType -> IO RequestBody
jsonBody route payload = case routeRequestMediaType route of
  Nothing -> pure (RequestBodyBS Bytes.empty)
  Just media | media == "application/json" || "+json" `Bytes.isSuffixOf` media -> pure (RequestBodyLBS (encode payload))
  _ -> throwIO (TransportError Code.TransportBadRequest "HTTP route requires a non-JSON body" Nothing Nothing)

json :: (ToJSON requestBodyType, FromJSON answer) => Http -> HttpRoute requestBodyType answer -> Maybe ResourceId -> Maybe Text -> requestBodyType -> IO answer
json http route resource override payload = report http $ exchange http route resource (jsonBody route payload) Nothing override [] $ \response -> do
  bytes <- Bytes.concat <$> brConsume (responseBody response)
  readAnswer route bytes

readAnswer :: FromJSON answer => HttpRoute request answer -> Bytes.ByteString -> IO answer
readAnswer route bytes = do
  let reject issue = throwIO (HttpFailure (TransportError Code.TransportError
        ("HTTP answer is not its declared schema: " <> Required.faultSaid issue) (Just (routeStatus route)) Nothing) False)
  case eitherDecodeStrict' bytes of
    Left _ -> reject Required.undecoded
    Right value -> case Required.faultHttp (routeName route) value of
      Just issue -> reject issue
      Nothing -> case fromJSON value of
        Error _ -> reject Required.undecoded
        Success answer -> pure answer

emit :: Http -> BusFrame -> IO (Maybe Integer)
emit http frame = Telemetry.sending frame $ do
  BusLog.frame (logger http) "EMIT" frame
  key <- UUID.toText <$> httpNewId (options http)
  let body = BusEmitRequest (busFrameChannel frame) (Just (clientId http)) (busFrameCorrelationId frame)
        (BusEmitRequestPayload (busFramePayloadAdditionalProperties (busFramePayload frame))) (busFrameScope frame) mempty
      sending = exchange http EmitOnBus Nothing (jsonBody EmitOnBus body) (Just key) Nothing [] $ \response -> do
        let count = do
              bytes <- deadline http (Settings.emitTimeoutMs (httpTiming (options http))) (Bytes.concat <$> brConsume (responseBody response))
              pure $ either (const Nothing) busEmitAcceptedSubscribers (eitherDecodeStrict' bytes)
        count `catch` (\(_ :: HttpFailure) -> pure Nothing) `catch` (\(_ :: HttpException) -> pure Nothing)
  Lifetime.run (lifetime http) (Transport.ownAction (transport http) sending)
    `catch` (\problem -> throwIO (failure problem))
