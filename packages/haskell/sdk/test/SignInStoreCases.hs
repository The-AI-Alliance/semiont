{-# LANGUAGE OverloadedStrings #-}
module SignInStoreCases (signInStoreCases, storeWriter) where

import TestProcess (python)
import Control.Concurrent (threadDelay)
import Control.Concurrent.Async (async, cancel, mapConcurrently_, poll)
import Control.Concurrent.STM
import Control.Exception (IOException, bracket, try)
import Control.Monad (forM_, unless, void, when)
import Data.Aeson (FromJSON, Value(..), eitherDecodeStrict', encode, fromJSON, Result(..), object, (.=), toJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Lazy as Lazy
import qualified Data.ByteString.Base64.URL as Base64
import Data.Foldable (toList)
import Data.List (isPrefixOf)
import qualified Data.Map.Strict as Map
import Data.Scientific (Scientific)
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (decodeUtf8)
import Data.Time (getCurrentTime)
import Data.Time.Clock.POSIX (posixSecondsToUTCTime, getPOSIXTime)
import GHC.Clock (getMonotonicTimeNSec)
import qualified Semiont.Issuer as Issuer
import qualified Semiont.Registry.Stored as Stored
import qualified Semiont.Retry as Retry
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.SignIn as SignIn
import qualified Semiont.SignInStore as Store
import Semiont.Errors (SignInError)
import Semiont.Types
import qualified ControlledTime as Time
import IssuerCases (peer, route, form)
import System.Directory (getTemporaryDirectory, createDirectory, removePathForcibly, removeFile, listDirectory)
import System.Environment (getExecutablePath, getEnvironment)
import System.Exit (ExitCode(..))
import System.FilePath ((</>), takeDirectory)
import System.IO (openBinaryTempFile, hClose, hPutStrLn, hFlush, hGetLine)
import System.Process

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))
member :: Text -> Value -> Value
member name (Object fields) = maybe (error "missing sign-in store case member") Prelude.id (KM.lookup (Key.fromText name) fields)
member _ _ = error "sign-in store case is not an object"
optional :: Text -> Value -> Value
optional name (Object fields) = maybe Null Prelude.id (KM.lookup (Key.fromText name) fields)
optional _ _ = error "sign-in store case is not an object"
array :: Value -> [Value]
array (Array values) = toList values
array _ = error "sign-in store cases are not an array"
decode :: FromJSON value => Value -> IO value
decode value = case fromJSON value of Error message -> ioError (userError message); Success parsed -> pure parsed
readJSON :: FilePath -> IO Value
readJSON filename = Bytes.readFile filename >>= either (ioError . userError) pure . eitherDecodeStrict'
withDirectory :: (FilePath -> IO result) -> IO result
withDirectory = bracket make removePathForcibly
  where make = do
          parent <- getTemporaryDirectory
          (name,handle) <- openBinaryTempFile parent "semiont-haskell-sign-ins"
          hClose handle
          removeFile name
          createDirectory name
          pure name

now :: Scientific
now = 1800000000
jwt :: Scientific -> Text -> Bool -> Text
jwt instant name expired = "e30."<>decodeUtf8 (Base64.encodeUnpadded (Lazy.toStrict (encode
  (object ["iss" .= String "http://issuer.test", "email" .= String "account@example.test", "caseName" .= name,
    "iat" .= (instant-7200), "exp" .= (instant+if expired then -3600 else 3600)]))))<>"."
held :: Text -> Text -> StoredSession
held access refresh = StoredSession access Issuer.scriptClientId refresh Nothing "http://issuer.test/token" KM.empty
clockOptions :: Time.ControlledTime -> Retry.RetryOptions
clockOptions time = Retry.RetryOptions (Time.now time) (Time.waitUntil time) (pure 0)
storeOptions :: Time.ControlledTime -> Store.SignInStoreOptions
storeOptions time = Store.SignInStoreOptions (clockOptions time) 10 (pure (posixSecondsToUTCTime (fromInteger (floor now))))

signInStoreCases :: FilePath -> IO ()
signInStoreCases root = do
  table <- readJSON (root </> "protocol/specs/src/sign-in-store/cases.json")
  require "sign-in store authority has no path or renewal cases" (not (null (array (member "cases" table))) && not (null (array (member "renewals" table))))
  forM_ (array (member "cases" table)) $ \row -> do
    platform <- decode (member "os" row)
    home <- decode (member "home" row)
    xdg <- decode (optional "xdgStateHome" row)
    local <- decode (optional "localAppData" row)
    expected <- decode (member "dir" row)
    require "state directory differs from its platform authority" (Store.stateDirectory platform home xdg local==expected)
  forM_ ["memory","registry","file"] $ \kind -> forM_ (array (member "renewals" table)) $ \row -> withDirectory $ \directory -> do
    time <- Time.newTime
    backend <- case kind :: Text of
      "memory" -> SignIn.newMemorySignIn
      "registry" -> Stored.keptIn <$> Storage.newMemoryStorage <*> pure "local:cases"
      "file" -> do
        store <- Store.newSignInStore (storeOptions time) (directory </> Store.signInFileName)
        pure (Store.entry store "local:cases")
      _ -> ioError (userError "unhandled native store kind")
    expired <- decode (member "expired" row) :: IO [Text]
    let mint name=jwt now name (name `elem` expired)
        pair value = do
          tokenName <- decode (member "token" value)
          refresh <- decode (member "refreshToken" value)
          pure (held (mint tokenName) refresh)
        meanwhile = case member "meanwhile" row of
          Null -> pure ()
          event -> case member "does" event of
            String "signs-out" -> SignIn.forget backend
            String "renews" -> do
              theirs <- pair (member "theirs" event)
              current <- SignIn.held backend >>= maybe (ioError (userError "another renewal found no sign-in")) pure
              void (SignIn.renewed backend current (IssuedTokens (storedSessionAccess theirs) (storedSessionRefresh theirs) KM.empty))
            _ -> ioError (userError "unhandled competing store change")
        at phase = case member "meanwhile" row of
          Null -> pure ()
          event -> when (member "when" event==String phase) meanwhile
    original <- pair (member "kept" row)
    SignIn.keep backend original
    at "before"
    spends <- newTVarIO []
    options <- peer time $ \request -> do
      require "a kept renewal rediscovered its learned endpoint" (route request=="/token")
      spent <- case lookup "refresh_token" (form request) of
        Just (Just bytes) -> pure (decodeUtf8 bytes)
        _ -> ioError (userError "renewal presented no refresh token")
      atomically (modifyTVar' spends (<>[spent]))
      at "during"
      issueName <- decode (member "token" (member "issues" row))
      let rotation=case optional "refreshToken" (member "issues" row) of
            Null -> []
            String value -> [("refresh_token",String value)]
            _ -> error "issued refresh token is not text"
      pure (200,Object (KM.fromList (("access_token",String (mint issueName)):rotation)))
    holdingName <- decode (member "holding" row)
    actual <- Issuer.refreshSession options backend (mint <$> holdingName) (pure now)
    givenName <- decode (member "gives" row)
    require ("kept renewal gave the wrong token: "++show (kind,row)) (actual==(mint <$> givenName))
    expectedSpend <- decode (member "spends" row)
    require "kept renewal spent the wrong token or made extra grants" . (==maybe [] (:[]) expectedSpend) =<< readTVarIO spends
    remains <- SignIn.held backend
    expected <- case member "leaves" row of Null -> pure Nothing; value -> Just <$> pair value
    require "kept renewal overwrote a competing renewal/sign-out" (remains==expected)
  nativeFileCases root
  putStrLn "PASS every state-home and kept-renewal case over memory, registry and native file stores"

nativeFileCases :: FilePath -> IO ()
nativeFileCases root = withDirectory $ \directory -> do
  time <- Time.newTime
  store <- Store.newSignInStore (storeOptions time) (directory </> Store.signInFileName)
  let first=held (jwt now "initial" False) "first-refresh"
      kept=Store.entry store "local:main"
  SignIn.keep kept first
  initial <- Store.signIn store "local:main" >>= maybe (ioError (userError "file store lost the sign-in")) pure
  require "file store lost issuer/email learned at sign-in"
    (signInIssuer initial=="http://issuer.test" && signInEmail initial==Just "account@example.test")
  let future=object ["futureVersion" .= (3::Integer), "large" .= (9007199254740993::Integer)]
      original=toJSON initial
      extend (Object fields)=Object (KM.insert "futureProperty" future fields)
      extend _=error "generated SignIn is not an object"
  Bytes.writeFile (Store.path store) (Lazy.toStrict (encode (object ["local:main" .= extend original,"futureEntry" .= future])))
  current <- SignIn.held kept >>= maybe (ioError (userError "extended sign-in was unreadable")) pure
  void (SignIn.renewed kept current (IssuedTokens (jwt now "rotated" False) "rotated-refresh" KM.empty))
  written <- readJSON (Store.path store)
  require "file renewal erased an unknown document member" (member "futureEntry" written==future)
  require "file renewal erased an unknown sign-in member" (member "futureProperty" (member "local:main" written)==future)
  renewed <- Store.signIn store "local:main" >>= maybe (ioError (userError "renewal was not kept")) pure
  require "renewal replaced the identity learned at sign-in" (signInEmail renewed==signInEmail initial && signInIssuer renewed==signInIssuer initial)
  forM_ ["null","[]","{unfinished","\"text\""] $ \bad -> do
    Bytes.writeFile (Store.path store) bad
    refused <- try (SignIn.keep kept first) :: IO (Either IOException ())
    require "writer accepted a corrupt/nonobject document" (case refused of Left _ -> True; _ -> False)
    require "writer replaced an unreadable sign-in file" . (==bad) =<< Bytes.readFile (Store.path store)
  removeFile (Store.path store)
  SignIn.keep kept first
  noIssuer <- try (SignIn.keep kept (held "not-a-token" "refresh")) :: IO (Either SignInError ())
  require "file store kept an issuerless token" (case noIssuer of Left _ -> True; _ -> False)
  wrongClient <- try (SignIn.keep kept first { storedSessionClientId="another-client" }) :: IO (Either SignInError ())
  require "file store kept a grant of a different client" (case wrongClient of Left _ -> True; _ -> False)
  nativeOwnerPolicy root store
  nativeLockCases root store first time
  crossProcessWriters store
  forM_ ["", ".", "..", directory<>"\0bad"] $ \invalid -> do
    refused <- try (Store.newSignInStore (storeOptions time) invalid) :: IO (Either IOException Store.SignInStore)
    require "store accepted a path that names no file" (case refused of Left _ -> True; _ -> False)
  let longDirectory=foldl (</>) (directory </> "Unicode λ 🍎") (replicate 4 (replicate 70 'a'))
  long <- Store.newSignInStore (storeOptions time) (longDirectory </> Store.signInFileName)
  SignIn.keep (Store.entry long "local:long-path") first
  require "native store could not read a long Unicode path" . (==Just first) =<< SignIn.held (Store.entry long "local:long-path")
  files <- listDirectory directory
  require "sign-in writer left a temporary credential file" (not (any (isPrefixOf (Store.signInFileName<>".tmp")) files))

nativeOwnerPolicy :: FilePath -> Store.SignInStore -> IO ()
nativeOwnerPolicy root store = do
  (exit,_,failure) <- readProcessWithExitCode python
    [root </> "packages/haskell/sdk/test/store-owner-policy.py",root </> "protocol/specs/src/sign-in-store/owner-only.json",
      takeDirectory (Store.path store),Store.path store] ""
  require ("native owner policy differs: "++failure) (exit==ExitSuccess)

nativeLockCases :: FilePath -> Store.SignInStore -> StoredSession -> Time.ControlledTime -> IO ()
nativeLockCases root store credential time = do
  let command=(proc python ["-u",root </> "packages/haskell/sdk/test/store-lock-peer.py",
        takeDirectory (Store.path store) </> "tokens.lock",root </> "protocol/specs/src/sign-in-store/owner-only.json",
        root </> "protocol/specs/src/sign-in-store/README.md"])
        { std_in=CreatePipe,std_out=CreatePipe }
  withCreateProcess command $ \input output _ process -> case (input,output) of
    (Just send,Just receive) -> do
      hGetLine receive >>= require "native lock peer could not acquire the protocol lock" . (=="held")
      blocked <- async (SignIn.keep (Store.entry store "local:blocked") credential)
      Time.settle
      state <- poll blocked
      require "native writer did not respect another process's lock" (case state of Nothing -> True; _ -> False)
      cancel blocked
      Time.advance time 1000000000
      require "cancelled lock waiter wrote a credential" . (==Nothing) =<< Store.signIn store "local:blocked"
      hPutStrLn send "release"
      hFlush send
      waitForProcess process >>= require "native lock peer failed" . (==ExitSuccess)
      SignIn.keep (Store.entry store "local:after-lock") credential
    _ -> ioError (userError "native peer pipes were not created")

crossProcessWriters :: Store.SignInStore -> IO ()
crossProcessWriters store = do
  executable <- getExecutablePath
  environment <- getEnvironment
  let start index = do
        let key="local:writer-"<>show index
            child=(proc executable ["--store-writer",Store.path store,key])
              {env=Just (("HPCTIXFILE",takeDirectory (Store.path store) </> ("writer-"<>show index<>".tix")):
                filter ((/="HPCTIXFILE") . fst) environment)}
        withCreateProcess child $ \_ _ _ process -> waitForProcess process >>= require "native writer process failed" . (==ExitSuccess)
  mapConcurrently_ start [1::Integer ..4]
  values <- Store.signIns store
  forM_ [1::Integer ..4] $ \index -> require "a process lost another stack's stored grant" (Map.member ("local:writer-"<>Text.pack (show index)) values)

-- The integration peer supplies a real interruptible clock at its application
-- boundary; it exercises native process exclusion rather than a timing table.
storeWriter :: FilePath -> Text -> IO ()
storeWriter filename key = do
  let clock=Retry.RetryOptions (fromIntegral <$> getMonotonicTimeNSec)
        (\due -> do current <- fromIntegral <$> getMonotonicTimeNSec; when (due>current) (threadDelay (fromInteger ((due-current+999) `div` 1000)))) (pure 0)
  store <- Store.newSignInStore (Store.SignInStoreOptions clock 10 getCurrentTime) filename
  instant <- realToFrac <$> getPOSIXTime
  SignIn.keep (Store.entry store key) (held (jwt instant key False) ("refresh-"<>key))
