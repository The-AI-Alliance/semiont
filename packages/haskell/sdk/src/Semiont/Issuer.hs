{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
-- | OAuth against the issuer named by a knowledge base. Network requests use
-- the application's HTTP pool; deadlines, retry and polling use its clock.
module Semiont.Issuer
  ( IssuerOptions(..), IssuerEndpoints(..), IssuedTokens(..), DeviceCode(..)
  , BeginAuthorizationOptions(..), PendingAuthorization(..), pendingAuthorizationKey
  , browserClientId, scriptClientId, signInScope
  , discoverIssuer, codeChallenge, beginAuthorization, completeAuthorization
  , refreshAtIssuer, refreshStoredSession, revokeAtIssuer, signInWithDeviceGrant
  ) where

import Control.Concurrent.Async (race)
import Control.Exception (throwIO, try)
import Control.Monad (unless, when)
import Crypto.Hash (Digest, SHA256, hash)
import Crypto.Random (getRandomBytes)
import Data.Aeson (FromJSON, Value(..), encode, eitherDecodeStrict', fromJSON, Result(..))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteArray as Memory
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Base64.URL as Base64
import qualified Data.ByteString.Lazy as Lazy
import Data.Maybe (fromMaybe)
import Data.Scientific (Scientific)
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8, decodeUtf8, decodeUtf8')
import Network.HTTP.Client
import Network.HTTP.Types (statusCode, renderQuery, parseQuery, hContentType, hAccept)
import Network.URI (parseURI, uriAuthority, uriUserInfo, uriScheme, uriFragment, uriQuery, uriToString)
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (SignInError(..))
import qualified Semiont.Gateway as Gateway
import Semiont.Internal.Http (HttpClient(..))
import qualified Semiont.Http.Routes as Route
import Semiont.Internal.Generated.OAuth
import Semiont.Internal.Generated.Stored (pendingAuthorizationKey)
import qualified Semiont.Retry as Retry
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.Registry.Stored as Stored
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types

data IssuerOptions = IssuerOptions
  { issuerHttpClient :: HttpClient
  , issuerTime :: Retry.RetryOptions
  , issuerTiming :: Timing.Settings
  }

data Answer = Answer Int Value

failWith :: Code.SignInCode -> Text -> Maybe Int -> IO value
failWith code message status = throwIO (SignInError code message status)

parse :: FromJSON value => Code.SignInCode -> Text -> Value -> IO value
parse code message value = case fromJSON value of
  Error _ -> failWith code message Nothing
  Success result -> pure result

text :: Text -> Value -> Maybe Text
text name (Object fields) = case KM.lookup (Key.fromText name) fields of Just (String value) -> Just value; _ -> Nothing
text _ _ = Nothing
number :: Text -> Value -> Maybe Scientific
number name (Object fields) = case KM.lookup (Key.fromText name) fields of Just (Number value) -> Just value; _ -> Nothing
number _ _ = Nothing
requiredText :: Code.SignInCode -> Text -> Value -> IO Text
requiredText code name value = maybe (failWith code ("The issuer's answer lacks "<>name) Nothing) pure (text name value)

requestJson :: IssuerOptions -> Code.SignInCode -> Text -> Maybe [(Text,Text)] -> IO Answer
requestJson options code endpoint form = do
  case parseURI (Text.unpack endpoint) of
    Just uri | uriScheme uri `elem` ["http:","https:"] && uriFragment uri==""
      && maybe False ((=="") . uriUserInfo) (uriAuthority uri) -> pure ()
    _ -> failWith code "The issuer endpoint is not a credential-free HTTP URL" Nothing
  parsedRequest <- try (parseRequest (Text.unpack endpoint))
  original <- case parsedRequest of
    Left (_ :: HttpException) -> failWith code "The issuer endpoint cannot be requested" Nothing
    Right value -> pure value
  let request = original
        { method=maybe "GET" (const "POST") form
        , requestHeaders=[(hAccept,"application/json")]
          ++maybe [] (const [(hContentType,"application/x-www-form-urlencoded")]) form
        , requestBody=maybe (RequestBodyBS Bytes.empty)
          (RequestBodyBS . renderQuery False . map (\(key,value) -> (encodeUtf8 key,Just (encodeUtf8 value)))) form
        , checkResponse = \_ _ -> pure ()
        , responseTimeout=responseTimeoutNone
        , redirectCount=0
        }
      HttpClient manager = issuerHttpClient options
      work = withResponse request manager $ \response -> do
        bytes <- Bytes.concat <$> brConsume (responseBody response)
        -- Refusal status is still meaningful when a server returns no JSON.
        -- Successful OAuth answers always require an actual JSON object.
        pure (Answer (statusCode (responseStatus response)) (either (const Null) Prelude.id (eitherDecodeStrict' bytes)))
  now <- Retry.retryNow (issuerTime options)
  let due = now + Timing.httpRequestTimeoutMs (issuerTiming options)*1000000
  answer <- try (race work (Retry.retryWaitUntil (issuerTime options) due))
  case answer of
    Left (_ :: HttpException) -> failWith code "The issuer request received no usable answer" Nothing
    Right (Right ()) -> failWith code "The issuer request deadline expired" Nothing
    Right (Left value) -> pure value

discoverIssuer :: IssuerOptions -> HttpEndpoint -> IO IssuerEndpoints
discoverIssuer options target = do
  base <- either (\message -> failWith Code.SignInDiscovery message Nothing) pure (Gateway.gatewayUrl target)
  Answer metadataStatus body <- requestJson options Code.SignInDiscovery (base<>Route.routePath Route.GetProtectedResourceMetadata) Nothing
  when (metadataStatus==404) (failWith Code.SignInNoIssuer "The knowledge base names no issuer" (Just metadataStatus))
  unless (metadataStatus==Route.routeStatus Route.GetProtectedResourceMetadata)
    (failWith Code.SignInDiscovery "The knowledge base refused its resource metadata" (Just metadataStatus))
  metadata <- parse Code.SignInDiscovery "The knowledge base returned invalid resource metadata" body
  identity <- case protectedResourceMetadataAuthorizationU5f_servers metadata of
    [] -> failWith Code.SignInNoIssuer "The knowledge base names no issuer" Nothing
    first:_ -> pure first
  Answer status doc <- requestJson options Code.SignInDiscovery (Text.dropWhileEnd (=='/') identity<>"/.well-known/openid-configuration") Nothing
  unless (status==200) (failWith Code.SignInDiscovery "The issuer refused discovery" (Just status))
  unless (text "issuer" doc==Just identity) (failWith Code.SignInDiscovery "The discovery document belongs to another issuer" Nothing)
  authorization <- requiredText Code.SignInDiscovery "authorization_endpoint" doc
  tokenEndpoint <- requiredText Code.SignInDiscovery "token_endpoint" doc
  pure (IssuerEndpoints authorization (text "device_authorization_endpoint" doc) identity (text "revocation_endpoint" doc) tokenEndpoint KM.empty)

codeChallenge :: Text -> Text
codeChallenge verifier = decodeUtf8 (Base64.encodeUnpadded (Memory.convert (hash (encodeUtf8 verifier) :: Digest SHA256)))
randomUrlSafe :: Int -> IO Text
randomUrlSafe count = decodeUtf8 . Base64.encodeUnpadded <$> (getRandomBytes count :: IO Bytes.ByteString)

beginAuthorization :: IssuerOptions -> BeginAuthorizationOptions -> Storage.SessionStorage -> IO Text
beginAuthorization options begin storage = do
  issuer <- discoverIssuer options (beginAuthorizationOptionsTarget begin)
  verifier <- randomUrlSafe 48
  state <- randomUrlSafe 24
  let pending = PendingAuthorization
        (beginAuthorizationOptionsExpectedDid begin) (beginAuthorizationOptionsExpectedName begin) issuer
        (beginAuthorizationOptionsKbId begin) (beginAuthorizationOptionsRedirectUri begin) state
        (beginAuthorizationOptionsTarget begin) verifier KM.empty
  address <- case parseURI (Text.unpack (issuerEndpointsAuthorization issuer)) of
    Just uri | uriScheme uri `elem` ["http:","https:"] && maybe False ((=="") . uriUserInfo) (uriAuthority uri) -> pure uri
    _ -> failWith Code.SignInDiscovery "The authorization endpoint is not a credential-free HTTP URL" Nothing
  let fields = [("response_type","code"),("client_id",browserClientId),("redirect_uri",beginAuthorizationOptionsRedirectUri begin)
        ,("scope",signInScope),("state",state),("code_challenge",codeChallenge verifier),("code_challenge_method","S256")]
      previous = parseQuery (encodeUtf8 (Text.pack (uriQuery address)))
      owned = map (encodeUtf8 . fst) fields
      query = renderQuery True (filter ((`notElem` owned) . fst) previous ++ map (\(key,value) -> (encodeUtf8 key,Just (encodeUtf8 value))) fields)
  Storage.set storage pendingAuthorizationKey (decodeUtf8 (Lazy.toStrict (encode pending)))
  pure (Text.pack (uriToString Prelude.id address { uriQuery=Text.unpack (decodeUtf8 query) } ""))

completeAuthorization :: IssuerOptions -> Text -> Storage.SessionStorage -> IO (PendingAuthorization, IssuedTokens)
completeAuthorization options callback storage = do
  raw <- Storage.update storage pendingAuthorizationKey (\previous -> (Nothing,previous))
  pending <- case raw >>= either (const Nothing) Just . eitherDecodeStrict' . encodeUtf8 of
    Nothing -> failWith Code.SignInNoPending "No sign-in is pending in this storage" Nothing
    Just value -> pure value
  address <- maybe (failWith Code.SignInExchange "The sign-in callback is not an absolute URL" Nothing) pure (parseURI (Text.unpack callback))
  let values = parseQuery (encodeUtf8 (Text.pack (uriQuery address)))
      one key = case [value | (name,Just value) <- values,name==encodeUtf8 key] of
        [value] -> either (const Nothing) Just (decodeUtf8' value)
        _ -> Nothing
  case one "error" of
    Just errorCode -> failWith (if errorCode=="access_denied" then Code.SignInDenied else Code.SignInExchange)
      "The issuer refused authorization" Nothing
    Nothing -> pure ()
  unless (maybe False (\value -> Memory.constEq (encodeUtf8 value) (encodeUtf8 (pendingAuthorizationState pending))) (one "state"))
    (failWith Code.SignInState "The response does not belong to this sign-in" Nothing)
  code <- maybe (failWith Code.SignInExchange "The callback carries no authorization code" Nothing) pure (one "code")
  when (Text.null code) (failWith Code.SignInExchange "The callback carries an empty authorization code" Nothing)
  (access,renewal) <- tokenGrant options (issuerEndpointsToken (pendingAuthorizationIssuer pending))
    [("grant_type","authorization_code"),("client_id",browserClientId),("redirect_uri",pendingAuthorizationRedirectUri pending)
    ,("code_verifier",pendingAuthorizationVerifier pending),("code",code)]
  refresh <- maybe (failWith Code.SignInExchange "The issuer returned no refresh token" Nothing) pure renewal
  pure (pending,IssuedTokens access refresh KM.empty)

tokenGrant :: IssuerOptions -> Text -> [(Text,Text)] -> IO (Text,Maybe Text)
tokenGrant options endpoint form = do
  Answer status body <- requestJson options Code.SignInExchange endpoint (Just form)
  unless (status==200) (failWith Code.SignInExchange "The issuer refused the token grant" (Just status))
  access <- maybe (failWith Code.SignInExchange "The issuer returned no access token" (Just status)) pure (text "access_token" body)
  pure (access,text "refresh_token" body)

refreshAtIssuer :: IssuerOptions -> Text -> Text -> Text -> IO IssuedTokens
refreshAtIssuer options endpoint identity refresh = do
  (access,renewal) <- tokenGrant options endpoint [("grant_type","refresh_token"),("client_id",identity),("refresh_token",refresh)]
  pure (IssuedTokens access (fromMaybe refresh renewal) KM.empty)

-- | Only a missing stored grant gives Nothing. Outages exhaust the refresh
-- budget as typed errors; an atomic comparison prevents resurrecting sign-out
-- or overwriting a grant another context has already rotated.
refreshStoredSession :: IssuerOptions -> Storage.SessionStorage -> Text -> IO (Maybe Text)
refreshStoredSession options storage identity = do
  saved <- Stored.storedSession storage identity
  case saved of
    Nothing -> pure Nothing
    Just original -> do
      issued <- Retry.retryWithBackoff (issuerTime options) (Timing.refreshRetry (issuerTiming options))
        (\failure -> Retry.retryable Retry.Refresh (signInStatus failure) Nothing False) (const Nothing)
        (refreshAtIssuer options (storedSessionTokenEndpoint original) (storedSessionClientId original) (storedSessionRefresh original))
      Storage.update storage (Stored.sessionKey identity) $ \raw ->
        case raw >>= either (const Nothing) Just . eitherDecodeStrict' . encodeUtf8 of
          Nothing -> (raw,Nothing)
          Just current | storedSessionAccess current/=storedSessionAccess original || storedSessionRefresh current/=storedSessionRefresh original ->
            (raw,Just (storedSessionAccess current))
          Just current -> (Just (decodeUtf8 (Lazy.toStrict (encode current
            { storedSessionAccess=issuedTokensAccess issued,storedSessionRefresh=issuedTokensRefresh issued }))),Just (issuedTokensAccess issued))

revokeAtIssuer :: IssuerOptions -> Text -> Text -> Text -> IO ()
revokeAtIssuer options endpoint identity refresh = do
  Answer status _ <- requestJson options Code.SignInExchange endpoint
    (Just [("token",refresh),("token_type_hint","refresh_token"),("client_id",identity)])
  unless (status==200) (failWith Code.SignInExchange "The issuer refused revocation" (Just status))

signInWithDeviceGrant :: IssuerOptions -> HttpEndpoint -> (DeviceCode -> IO ()) -> IO (IssuerEndpoints, IssuedTokens)
signInWithDeviceGrant options target onCode = do
  issuer <- discoverIssuer options target
  endpoint <- maybe (failWith Code.SignInDiscovery "The issuer offers no device authorization endpoint" Nothing) pure (issuerEndpointsDevice issuer)
  Answer status body <- requestJson options Code.SignInExchange endpoint (Just [("client_id",scriptClientId),("scope",signInScope)])
  unless (status==200) (failWith Code.SignInExchange "The issuer refused device authorization" (Just status))
  device <- requiredText Code.SignInExchange "device_code" body
  userCode <- requiredText Code.SignInExchange "user_code" body
  verification <- requiredText Code.SignInExchange "verification_uri" body
  expires <- maybe (failWith Code.SignInExchange "The device code has no lifetime" Nothing) pure (number "expires_in" body)
  when (expires<0) (failWith Code.SignInExchange "The device code has a negative lifetime" Nothing)
  onCode (DeviceCode expires userCode verification (text "verification_uri_complete" body) KM.empty)
  now <- Retry.retryNow (issuerTime options)
  let settings=issuerTiming options
      interval=max (fromInteger (Timing.devicePollFloorMs settings))
        (maybe (fromInteger (Timing.devicePollMs settings)) (*1000) (number "interval" body))
      deadline=now+ceiling (expires*1000000000)
      poll delay = do
        before <- Retry.retryNow (issuerTime options)
        Retry.retryWaitUntil (issuerTime options) (before+ceiling (delay*1000000))
        current <- Retry.retryNow (issuerTime options)
        when (current>deadline) (failWith Code.SignInExpired "The device code expired" Nothing)
        Answer pollStatus answer <- requestJson options Code.SignInExchange (issuerEndpointsToken issuer)
          (Just [("grant_type","urn:ietf:params:oauth:grant-type:device_code"),("device_code",device),("client_id",scriptClientId)])
        case (pollStatus,text "access_token" answer) of
          (200,Just access) -> do
            refresh <- maybe (failWith Code.SignInExchange "The issuer returned no refresh token" Nothing) pure (text "refresh_token" answer)
            pure (issuer,IssuedTokens access refresh KM.empty)
          _ -> case text "error" answer of
            Just "authorization_pending" -> poll delay
            Just "slow_down" -> poll (delay+fromInteger (Timing.deviceSlowDownMs settings))
            Just "access_denied" -> failWith Code.SignInDenied "The device sign-in was denied" (Just pollStatus)
            Just "expired_token" -> failWith Code.SignInExpired "The device code expired" (Just pollStatus)
            _ -> failWith Code.SignInExchange "The issuer refused the device token grant" (Just pollStatus)
  poll interval
