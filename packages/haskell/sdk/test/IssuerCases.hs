{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
module IssuerCases (issuerCases, serviceTokenCases, deviceClockCases, peer, httpPeer, streamingPeer, jsonReply, route, bodyOf, form) where

import Control.Concurrent.Async (async, cancel, wait, poll, replicateConcurrently)
import Control.Concurrent.STM
import Control.Exception (try, bracket)
import Control.Monad (unless, when, void)
import Data.Aeson (Value(..), object, (.=), encode, eitherDecodeStrict', fromJSON, Result(..))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import qualified Data.UUID.Types as UUID
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Char8 as Char8
import qualified Data.ByteString.Lazy as Lazy
import Data.Either (lefts)
import Data.Foldable (toList)
import Data.List (find)
import Data.IORef
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import Network.HTTP.Client (defaultManagerSettings, managerRawConnection, noProxy)
import Network.HTTP.Client.Internal (makeConnection)
import Network.HTTP.Types (parseQuery)
import qualified Semiont.Http as Http
import qualified Semiont.Client as Client
import qualified Semiont.ClientAssertion as Assertion
import qualified Semiont.ServiceToken as Service
import qualified Semiont.Auth as Auth
import qualified Semiont.Session as Session
import qualified Semiont.SignIn as SignIn
import qualified Semiont.StateValue as State
import qualified Semiont.Transport as Transport
import qualified Semiont.Issuer as Issuer
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (BusRequestError, SignInError(..), TransportError(..))
import qualified Semiont.Retry as Retry
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.Registry.Stored as Stored
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Timing as Budget
import Semiont.Types
import qualified Streaming.Prelude as Stream
import qualified ControlledTime as Time
-- Runs protocol/specs/src/client/clock-cases.json through the shared clock runner.
import ClockCases (clockCasesFor, Scenario(..))
import System.FilePath ((</>))
import qualified Data.ByteString.Base64.URL as Base64

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))
member :: Text -> Value -> Value
member name (Object fields) = maybe (error "missing issuer clock member") Prelude.id (KM.lookup (Key.fromText name) fields)
member _ _ = error "issuer clock value is not an object"
values :: Value -> [Value]
values (Array rows) = toList rows
values _ = error "issuer answers are not a list"

-- An issuer over a peer that answers each request with one JSON reply.
peer :: Time.ControlledTime -> (Bytes.ByteString -> IO (Int,Value)) -> IO Issuer.IssuerOptions
peer time answer = do
  pool <- httpPeer (fmap (uncurry jsonReply) . answer)
  pure (Issuer.IssuerOptions pool (Retry.RetryOptions (Time.now time) (Time.waitUntil time) (pure 0)) Timing.protocolSettings)

-- | A JSON reply that closes its connection.
jsonReply :: Int -> Value -> Bytes.ByteString
jsonReply status body = let content=Lazy.toStrict (encode body) in
  "HTTP/1.1 "<>Char8.pack (show status)<>" reply\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
    <>Char8.pack (show (Bytes.length content))<>"\r\n\r\n"<>content

-- | Each request answered with one reply.
httpPeer :: (Bytes.ByteString -> IO Bytes.ByteString) -> IO Http.HttpClient
httpPeer answer = streamingPeer (\request write _ -> answer request >>= atomically . write)

-- | A real http-client connection, driven byte for byte. Once the request's declared body is in, answer is handed
-- it, what writes the reply's bytes, at once or later, and what hangs up; a connection the client closes reads no more.
streamingPeer :: (Bytes.ByteString -> (Bytes.ByteString -> STM ()) -> STM () -> IO ()) -> IO Http.HttpClient
streamingPeer answer = do
  let connect _ _ _ = do
        accumulated <- newIORef Bytes.empty
        sent <- newIORef False
        output <- newTQueueIO
        closed <- newTVarIO False
        let readBytes = atomically (readTQueue output `orElse` (readTVar closed >>= check >> pure Bytes.empty))
            hangUp = writeTVar closed True
            writeBytes bytes = do
              request <- atomicModifyIORef' accumulated (\before -> let after=before<>bytes in (after,after))
              already <- readIORef sent
              let (headers,rest)=Bytes.breakSubstring "\r\n\r\n" request
                  lengthHeader=find (Char8.isPrefixOf "Content-Length:") (Char8.lines headers)
                  lengthValue=maybe 0 (fst . fromRead . Char8.readInt . Char8.dropWhile (==' ') . Char8.drop 15) lengthHeader
                  fromRead=maybe (error "invalid HTTP content length") Prelude.id
              when (not already && not (Bytes.null rest) && Bytes.length (Bytes.drop 4 rest)>=lengthValue) $ do
                writeIORef sent True
                answer request (writeTQueue output) hangUp
        makeConnection readBytes writeBytes (atomically hangUp)
  Http.newHttpClient noProxy defaultManagerSettings { managerRawConnection=pure connect }

-- The generated endpoint's tag and protocol are explicit nominal constructors.
endpoint :: HttpEndpoint
endpoint = HttpEndpoint "localhost" HttpEndpointKindHttp 4000 HttpEndpointProtocolHttp KM.empty

metadata :: Value
metadata = object ["authorization_servers" .= [String "http://issuer.test"],"bearer_methods_supported" .= [String "header"],"resource" .= String "http://localhost:4000"]
discovery :: Value
discovery = object ["issuer" .= String "http://issuer.test", "authorization_endpoint" .= String "http://issuer.test/authorize?keep=yes"
  ,"token_endpoint" .= String "http://issuer.test/token", "device_authorization_endpoint" .= String "http://issuer.test/device"
  ,"revocation_endpoint" .= String "http://issuer.test/revoke"]
route :: Bytes.ByteString -> Bytes.ByteString
route request = case Char8.words (Char8.takeWhile (/='\r') request) of [_,path,_] -> path; _ -> error "invalid HTTP request line"
bodyOf :: Bytes.ByteString -> Bytes.ByteString
bodyOf = Bytes.drop 4 . snd . Bytes.breakSubstring "\r\n\r\n"
form :: Bytes.ByteString -> [(Bytes.ByteString,Maybe Bytes.ByteString)]
form = parseQuery . bodyOf

issuerCases :: Map.Map Text Value -> IO ()
issuerCases fixtures = do
  require "PKCE differs from RFC 7636 Appendix B"
    (Issuer.codeChallenge "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"=="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  time <- Time.newTime
  seen <- newTVarIO []
  status <- newTVarIO (200::Int)
  tokenBody <- newTVarIO (object ["access_token" .= String "access", "refresh_token" .= String "refresh"])
  hold <- newTVarIO Nothing
  identities <- newTVarIO [200::Int]
  options <- peer time $ \request -> do
    atomically (modifyTVar' seen (<>[request]))
    case route request of
      "/.well-known/oauth-protected-resource" -> pure (200,metadata)
      "/.well-known/openid-configuration" -> pure (200,discovery)
      "/token" -> do
        waiting <- readTVarIO hold
        mapM_ (atomically . readTMVar) waiting
        (,) <$> readTVarIO status <*> readTVarIO tokenBody
      "/revoke" -> pure (200,object [])
      "/api/users/me" -> do
        code <- if "Bearer refused-override" `Bytes.isInfixOf` request then pure 401 else atomically $ do
          replies <- readTVar identities
          case replies of
            [] -> throwSTM (userError "identity peer has no answer")
            first:rest -> writeTVar identities (if null rest then [first] else rest) >> pure first
        if code/=200 then pure (code,object ["error" .= String "identity refused"])
          else maybe (ioError (userError "factory test has no UserResponse fixture")) (pure . (200,)) (Map.lookup "UserResponse" fixtures)
      path | "/bus/subscribe" `Bytes.isPrefixOf` path -> pure (503,object [])
      _ -> ioError (userError "unhandled issuer route")
  issuer <- Issuer.discoverIssuer options endpoint
  require "issuer discovery lost an endpoint" (issuerEndpointsRevocation issuer==Just "http://issuer.test/revoke")
  storage <- Storage.newMemoryStorage
  let begin=BeginAuthorizationOptions (Just "did:web:knowledge.test") (Just "Knowledge") (Just "kb") "app://callback" endpoint KM.empty
  url <- Issuer.beginAuthorization options begin storage
  require "authorization URL lost the issuer's own query" ("keep=yes" `Text.isInfixOf` url)
  require "authorization URL did not request PKCE" ("code_challenge_method=S256" `Text.isInfixOf` url)
  raw <- Storage.get storage Issuer.pendingAuthorizationKey
  pending <- case raw of
    Just encoded -> either (ioError . userError) pure (eitherDecodeStrict' (encodeUtf8 encoded))
    Nothing -> ioError (userError "authorization was not stored")
  let callback="app://callback?code=the-code&state="<>pendingAuthorizationState pending
  (kept,tokens) <- Issuer.completeAuthorization options callback storage
  require "redirect completion lost pending identity" (kept==pending && issuedTokensRefresh tokens=="refresh")
  repeated <- try (Issuer.completeAuthorization options callback storage)
  require "replayed redirect callback made another grant" (case repeated of Left failure -> signInErrorCode failure==Code.SignInNoPending; Right _ -> False)
  asks <- readTVarIO seen
  let grants=filter ((=="/token") . route) asks
  require "redirect exchanged more than one code" (length grants==1)
  case grants of
    [request] -> do
      require "code exchange omitted the stored verifier" (lookup "code_verifier" (form request)==Just (Just (encodeUtf8 (pendingAuthorizationVerifier pending))))
      require "code exchange invented a client secret" (lookup "client_secret" (form request)==Nothing)
    _ -> ioError (userError "no redirect grant")
  -- An issuer need not rotate refresh tokens.
  atomically (writeTVar tokenBody (object ["access_token" .= String "next"]))
  issued <- Issuer.refreshAtIssuer options "http://issuer.test/token" "client" "original"
  require "nonrotating issuer lost the refresh token" (issuedTokensRefresh issued=="original")
  let stored=StoredSession "before" "client" Nothing "original" Nothing "http://issuer.test/token" KM.empty
  Stored.storeSession storage "kb" stored
  entered <- newEmptyTMVarIO
  release <- newEmptyTMVarIO
  atomically (writeTVar hold (Just release))
  -- The peer's request is blocked until the external storage change commits.
  pendingGrant <- async $ do atomically (putTMVar entered ()); Issuer.refreshSession options (Stored.keptIn storage "kb") (Just "before") (pure 1800000000)
  atomically (readTMVar entered)
  Time.settle
  Stored.clearStoredSession storage "kb"
  atomically (putTMVar release ())
  require "rotated grant resurrected signed-out storage" . (==Nothing) =<< wait pendingGrant
  atomically (writeTVar hold Nothing)
  Stored.storeSession storage "kb" stored
  renewed <- Issuer.refreshSession options (Stored.keptIn storage "kb") (Just "before") (pure 1800000000)
  require "stored grant returned no access token" (renewed==Just "next")
  persisted <- Stored.storedSession storage "kb"
  require "stored grant did not atomically keep its rotation" (fmap storedSessionAccess persisted==Just "next")
  atomically (writeTVar status 400)
  refused <- try (Issuer.refreshSession options (Stored.keptIn storage "kb") (Just "before") (pure 1800000000))
  require "issuer refusal lost its terminal status" (case refused of Left failure -> signInStatus failure==Just 400; Right _ -> False)
  Issuer.revokeAtIssuer options "http://issuer.test/revoke" "client" "original"
  atomically (writeTVar status 200 >> writeTVar tokenBody (object ["access_token" .= String "fresh"]))
  let targetKb=KbTarget (KbEndpointBranch1 endpoint) "http-factory" "HTTP factory" KM.empty
      sessionOptions=Session.SessionOptions "http-factory" targetKb (Stored.keptIn storage (kbTargetId targetKb)) Nothing Nothing Nothing
        (const (ioError (userError "factory unexpectedly ended sign-in"))) (pure 1800000000)
      http=Http.HttpOptions "http://unused.test:1" (Issuer.issuerHttpClient options)
        (ioError (userError "factory did not replace the original token reader"))
        (const (ioError (userError "factory did not replace the original renewer")))
        (Issuer.issuerTime options) Timing.protocolSettings (pure (UUID.fromWords 0 0 0 1)) Set.empty
        (pure Map.empty) (\_ _ -> pure ())
  revocable <- SignIn.newMemorySignIn
  SignIn.keep revocable stored { storedSessionRefresh="signed-out", storedSessionRevocationEndpoint=Just "http://issuer.test/revoke" }
  require "sign-out did not say the issuer revoked the sign-in" =<< Session.signOut http revocable
  require "sign-out kept the sign-in it revoked" . (==Nothing) =<< SignIn.held revocable
  require "sign-out did not revoke the sign-in's refresh token at its endpoint" . any (\request -> route request=="/revoke"
    && ("token","signed-out") `elem` [(name,value) | (name,Just value) <- form request]) =<< readTVarIO seen
  unrevocable <- SignIn.newMemorySignIn
  SignIn.keep unrevocable stored
  require "sign-out said a sign-in that names no revocation endpoint was revoked" . not =<< Session.signOut http unrevocable
  require "sign-out kept a sign-in that names no revocation endpoint" . (==Nothing) =<< SignIn.held unrevocable
  bracket (Session.fromIssuedSession http Nothing sessionOptions stored) Session.closeOpenedSession $ \opened -> do
    let session=Session.openedSession opened
    require "issued-session factory did not renew its expired grant" . (==Just "fresh")
      =<< atomically (State.current (Session.token session))
    auth <- maybe (ioError (userError "HTTP session has no auth namespace")) pure (Client.auth (Session.client session))
    person <- Auth.me auth Nothing
    expected <- case Map.lookup "UserResponse" fixtures of
      Just value -> case fromJSON value of Success parsed -> pure parsed; Error message -> ioError (userError message)
      Nothing -> ioError (userError "missing UserResponse")
    require "opened session client did not use its typed gateway" (person==expected)
    requests <- readTVarIO seen
    require "the client did not read the session's rotated token cell"
      (any (\request -> route request=="/api/users/me" && "Authorization: Bearer fresh" `Bytes.isInfixOf` request) requests)
    Session.closeOpenedSession opened
    require "opened session closer left the client open" . (==Transport.Closed)
      =<< atomically (State.current (Client.state (Session.client session)))
    require "factory said a startup failure" . null . lefts =<< Session.errors session Stream.toList_
  let agentKb=targetKb { kbTargetId="agent-factory" }
      agentOptions=sessionOptions { Session.sessionKb=agentKb }
  atomically (writeTVar identities [503,200])
  bracket (Service.newServiceTokenSecret options "http://issuer.test" "account" "test-only-secret") Service.dispose $ \service -> do
    opening <- async (Session.signInAgent http agentOptions (Budget.RetryBudget 2 10 20) service)
    Time.settle
    Time.advance time 4000000
    waitingForRetry <- poll opening
    require "agent retried before its caller-controlled equal-jitter delay" (case waitingForRetry of Nothing -> True; _ -> False)
    Time.advance time 1000000
    opened <- wait opening
    let session=Session.openedSession opened
    bracket (pure opened) Session.closeOpenedSession $ \_ -> do
      person <- atomically (State.current (Session.user session))
      expected <- case Map.lookup "UserResponse" fixtures of
        Just value -> case fromJSON value of Success parsed -> pure parsed; Error message -> ioError (userError message)
        Nothing -> ioError (userError "missing agent identity fixture")
      require "agent did not retain the gateway's actual identity" (person==Just expected)
      require "agent manufactured a stored refresh grant" . (==Nothing) =<< Stored.storedSession storage (kbTargetId agentKb)
      auth <- maybe (ioError (userError "agent has no identity operation")) pure (Client.auth (Session.client session))
      before <- filter ((=="/token") . route) <$> readTVarIO seen
      refusedIdentity <- try (Auth.me auth (Just "refused-override")) :: IO (Either TransportError UserResponse)
      require "explicit credential refusal was not final" (case refusedIdentity of Left failure -> transportErrorCode failure==Code.TransportUnauthorized; _ -> False)
      after <- filter ((=="/token") . route) <$> readTVarIO seen
      require "explicit credential refusal renewed the inherited credential" (length before==length after)
      require "explicit credential refusal quarantined the held token" . (==Just "fresh")
        =<< atomically (State.current (Session.token session))
      void (Auth.me auth Nothing)
    require "agent disposal disposed its borrowed service account" . (=="fresh") =<< Service.token service
  -- The agent closes while its token is renewed: the refusal waiting on the
  -- renewal is given no token, the answer that comes later is not taken, and a
  -- refusal after the close, of the token held or one replaced, is given none,
  -- with the issuer asked nothing more.
  atomically (writeTVar identities [200])
  bracket (Service.newServiceTokenSecret options "http://issuer.test" "account" "test-only-secret") Service.dispose $ \service -> do
    opened <- Session.signInAgent http agentOptions (Budget.RetryBudget 2 10 20) service
    let session=Session.openedSession opened
        tokenAsks = length . filter ((=="/token") . route) <$> readTVar seen
    first <- atomically (State.current (Session.token session))
    granting <- newEmptyTMVarIO
    atomically (writeTVar hold (Just granting) >> writeTVar tokenBody (object ["access_token" .= String "late"]))
    asked <- atomically tokenAsks
    refusing <- async (try (Session.refresh session first) :: IO (Either BusRequestError (Maybe Text)))
    atomically (tokenAsks >>= check . (==asked+1))
    Session.closeOpenedSession opened
    refusal <- wait refusing
    require "a refusal waiting on the renewal the agent's close ended was not given no token" (refusal==Right Nothing)
    atomically (putTMVar granting ())
    Time.settle
    require "a closed agent took the token its ended renewal brought" . (==first) =<< atomically (State.current (Session.token session))
    afterwards <- try (Session.refresh session first) :: IO (Either BusRequestError (Maybe Text))
    require "a refusal made once the agent was closed was not given no token" (afterwards==Right Nothing)
    replaced <- try (Session.refresh session (Just "replaced")) :: IO (Either BusRequestError (Maybe Text))
    require "a refusal of a token already replaced, once the agent was closed, was not given no token" (replaced==Right Nothing)
    require "a closed agent asked the issuer for another token" . (==asked+1) =<< atomically tokenAsks
  atomically (writeTVar hold Nothing >> writeTVar tokenBody (object ["access_token" .= String "fresh"]))
  atomically (writeTVar identities [401])
  ended <- newTVarIO []
  beforeRefusal <- length . filter ((=="/token") . route) <$> readTVarIO seen
  let refusedOptions=agentOptions {
        Session.sessionOnAuthFailed = \reason -> atomically (modifyTVar' ended (<>[reason])) }
  bracket (Service.newServiceTokenSecret options "http://issuer.test" "account" "test-only-secret") Service.dispose $ \service ->
    bracket (async (try (Session.signInAgent http refusedOptions (Budget.RetryBudget 2 10 20) service)
      :: IO (Either TransportError Session.OpenedSession))) cancel $ \attempt -> do
      Time.settle
      result <- poll attempt
      require "agent retried a gateway-refused freshly issued credential" (case result of
        Just (Right (Left failure)) -> transportErrorCode failure==Code.TransportUnauthorized
        _ -> False)
  afterRefusal <- length . filter ((=="/token") . route) <$> readTVarIO seen
  require "agent refusal caused extra account grants" (afterRefusal==beforeRefusal+1)
  require "agent refusal was not reported as a refused session" . (==[SessionEndReasonRefused]) =<< readTVarIO ended
  putStrLn "PASS issuer discovery, RFC PKCE, one-shot redirect, atomic rotation, explicit credentials and agent startup over real HTTP parsing"

deviceClockCases :: FilePath -> IO [Text]
deviceClockCases root = clockCasesFor root ["deviceGrant"] $ \time row -> do
  calls <- newTVarIO (0::Integer)
  let given=member "given" row
      script=values (member "answers" given)
      interval=case given of Object fields -> KM.lookup "intervalSeconds" fields; _ -> error "missing device clock options"
  require "device polling clock has no answers" (not (null script))
  options <- peer time $ \request -> case route request of
    "/.well-known/oauth-protected-resource" -> pure (200,metadata)
    "/.well-known/openid-configuration" -> pure (200,discovery)
    "/device" -> pure (200,Object (KM.fromList
      ([ ("device_code",String "device"),("user_code",String "USER"),("verification_uri",String "http://issuer.test/approve"),("expires_in",Number 900)]
      ++maybe [] (\value -> [("interval",value)]) interval)))
    "/token" -> do
      count <- atomically $ do n <- readTVar calls; writeTVar calls (n+1); pure n
      pure (400,object ["error" .= (script !! min (fromInteger count) (length script-1))])
    _ -> ioError (userError "unhandled device clock request")
  operation <- async (Issuer.signInWithDeviceGrant options endpoint (const (pure ())))
  pure (Scenario (pure ()) (readTVarIO calls) (cancel operation))

serviceTokenCases :: FilePath -> IO ()
serviceTokenCases root = do
  time <- Time.newTime
  discoveries <- newTVarIO (0::Integer)
  grants <- newTVarIO (0::Integer)
  requests <- newTVarIO []
  reply <- newTVarIO (200::Int)
  discoveryReply <- newTVarIO (200::Int)
  duration <- newTVarIO (Just (3600::Integer))
  hold <- newTVarIO Nothing
  options <- peer time $ \request -> case route request of
    "/.well-known/openid-configuration" -> do
      atomically (modifyTVar' discoveries (+1))
      code <- readTVarIO discoveryReply
      pure (code,discovery)
    "/token" -> do
      count <- atomically $ do
        modifyTVar' grants (+1)
        modifyTVar' requests (<>[request])
        readTVar grants
      blocked <- readTVarIO hold
      mapM_ (atomically . readTMVar) blocked
      code <- readTVarIO reply
      lifetime <- readTVarIO duration
      pure (code,Object (KM.fromList ([ ("access_token",String ("opaque-"<>Text.pack (show count))) ]
        ++maybe [] (\seconds -> [("expires_in",Number (fromInteger seconds))]) lifetime)))
    _ -> ioError (userError "service token used an unrelated endpoint")
  pem <- Bytes.readFile (root </> "packages/haskell/sdk/test/fixtures/client-assertion-test-only.pem")
  key <- either (ioError . userError . Text.unpack) pure (Assertion.privateKeyFromPem pem)
  bracket (Service.newServiceTokenKey options "http://issuer.test" "account" key (pure 1800000000)) Service.dispose $ \service -> do
    answers <- replicateConcurrently 20 (Service.token service)
    require "concurrent service asks did not share the first grant" (all (=="opaque-1") answers)
    require "service authorization changed the held token" . (=="Bearer opaque-1") =<< Service.authorization service
    require "service endpoint was not discovered once" . (==1) =<< readTVarIO discoveries
    require "service made extra initial grants" . (==1) =<< readTVarIO grants
    Time.advance time (3299*1000000000)
    require "service renewed before its controlled lifetime" . (=="opaque-1") =<< Service.token service
    Time.advance time 1000000000
    require "service reused a grant due for renewal" . (=="opaque-2") =<< Service.token service
    atomically (writeTVar reply 400)
    refused <- try (Service.renew service "opaque-2")
    require "failed account renewal lost the issuer status" (case refused of Left failure -> signInStatus failure==Just 400; Right _ -> False)
    atomically (writeTVar reply 200)
    require "failed renewal restored the refused token cache" . (=="opaque-4") =<< Service.token service
    require "failed grant forgot the successfully discovered endpoint" . (==1) =<< readTVarIO discoveries
    atomically (writeTVar duration Nothing)
    require "forced service renewal did not renew" . (=="opaque-5") =<< Service.renew service "opaque-4"
    require "a grant with no lifetime was cached" . (=="opaque-6") =<< Service.token service
    proofs <- readTVarIO requests
    let decodedProof request = do
          compact <- case lookup "client_assertion" (form request) of
            Just (Just encoded) -> pure (decodeUtf8 encoded)
            _ -> ioError (userError "key grant did not carry an assertion")
          require "key grant sent a client secret" (lookup "client_secret" (form request)==Nothing)
          case Text.splitOn "." compact of
            [_,claims,_] -> do
              bytes <- either (ioError . userError) pure (Base64.decodeUnpadded (encodeUtf8 claims))
              value <- either (ioError . userError) pure (eitherDecodeStrict' bytes)
              case member "jti" value of String nonce -> pure nonce; _ -> ioError (userError "client assertion nonce is not text")
            _ -> ioError (userError "service assertion is not a JWT")
    nonces <- mapM decodedProof proofs
    require "client assertion nonce was reused" (Set.size (Set.fromList nonces)==length nonces)
    blocked <- newEmptyTMVarIO
    atomically (writeTVar hold (Just blocked))
    result <- newEmptyTMVarIO
    start <- Time.now time
    let due = start + Timing.httpRequestTimeoutMs Timing.protocolSettings*1000000
    operation <- async $ do
      answer <- try (Service.token service) :: IO (Either SignInError Text)
      atomically (putTMVar result answer)
    -- The request reads the clock for its deadline only after signing the assertion, whose entropy reads are foreign
    -- calls that settle counts as idle. The clock moves once that deadline is waiting.
    Time.awaitDue time due
    Time.advance time (due - start - 1000000)
    require "account request expired before its controlled deadline" =<< atomically (isEmptyTMVar result)
    Time.advance time 1000000
    answer <- atomically (readTMVar result)
    require "account request did not expire at its controlled deadline" (case answer of Left failure -> signInStatus failure==Nothing; _ -> False)
    wait operation
    atomically (writeTVar hold Nothing)
  -- A failed discovery is not a remembered endpoint.
  atomically (writeTVar discoveryReply 503)
  bracket (Service.newServiceTokenSecret options "http://issuer.test" "account" "test-only-secret") Service.dispose $ \service -> do
    absent <- try (Service.token service)
    require "service discovery refusal lost its code" (case absent of Left failure -> signInErrorCode failure==Code.SignInDiscovery; Right _ -> False)
    atomically (writeTVar discoveryReply 200)
    void (Service.token service)
    captured <- readTVarIO requests
    case reverse captured of
      request:_ -> require "secret account proof has the wrong fields"
        (Set.fromList (map fst (form request))==Set.fromList ["grant_type","client_id","client_secret"])
      [] -> ioError (userError "secret account sent no grant")
    require "failed discovery was cached" . (==3) =<< readTVarIO discoveries
  putStrLn "PASS service account key/secret grants, deduplication, controlled reuse/deadlines, fresh proofs and refusal quarantine"
