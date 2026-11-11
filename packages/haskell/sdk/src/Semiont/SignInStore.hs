{-# LANGUAGE OverloadedStrings #-}
-- | The launcher-compatible tokens.json store. Reads see whole documents;
-- every change holds tokens.lock through an atomic sibling-file replacement.
module Semiont.SignInStore
  ( SignInStore, SignInStoreOptions(..), newSignInStore, path, signInFileName, stateDirectory, thisSystem
  , signIns, signIn, entry
  ) where

import Control.Concurrent.MVar
import Control.Exception (IOException, bracketOnError, catch, finally, throwIO)
import Control.Monad (unless, when)
import Data.Aeson (Object, Value(..), eitherDecodeStrict', encode, fromJSON, Result(..), toJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Crypto.Random (getRandomBytes)
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Base64.URL as Base64
import qualified Data.ByteString.Char8 as Char8
import qualified Data.ByteString.Lazy as Lazy
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Time (UTCTime, formatTime, defaultTimeLocale)
import Data.Time.Clock.POSIX (posixSecondsToUTCTime, utcTimeToPOSIXSeconds)
import Data.Time.Format.ISO8601 (iso8601ParseM)
import qualified Semiont.Internal.NativeStore as Native
import Semiont.Internal.Generated.SignInStore (signInFileName)
import qualified Semiont.Internal.Generated.SignInStore as Policy
import qualified Semiont.Internal.Generated.OAuth as OAuth
import qualified Semiont.Internal.SignIn as SignIn
import qualified Semiont.Retry as Retry
import qualified Semiont.Tokens as Tokens
import Semiont.Errors (SignInError(..))
import Semiont.ErrorCodes (SignInCode(SignInExchange))
import Semiont.Types (SignIn(..), StoredSession(..))
import System.Directory (createDirectoryIfMissing, renameFile, removeFile)
import System.FilePath (takeDirectory, takeFileName, (</>))
import qualified System.FilePath.Posix as Posix
import qualified System.FilePath.Windows as Windows
import System.IO (IOMode(WriteMode), openBinaryFile, hClose, hFlush, hIsClosed)
import System.IO.Error (isDoesNotExistError)
import qualified System.Info as System

data SignInStoreOptions = SignInStoreOptions
  { signInStoreTime :: Retry.RetryOptions
  , signInStoreLockRetryMs :: Integer
  -- ^ A positive interval on the caller's clock between nonblocking attempts.
  , signInStoreWallNow :: IO UTCTime
  }
data SignInStore = SignInStore SignInStoreOptions FilePath (MVar ())

newSignInStore :: SignInStoreOptions -> FilePath -> IO SignInStore
newSignInStore options filename = do
  when (null filename || '\0' `elem` filename || takeFileName filename `elem` ["", ".", ".."])
    (ioError (userError "The sign-in store needs a named file path"))
  when (signInStoreLockRetryMs options<=0) (ioError (userError "Sign-in lock retry interval must be positive"))
  SignInStore options filename <$> newMVar ()
path :: SignInStore -> FilePath
path (SignInStore _ filename _) = filename

-- | No environment is read: the caller supplies its standard directory values.
-- A missing home is an absence even when a platform-specific directory is set.
stateDirectory :: Text -> Maybe FilePath -> Maybe FilePath -> Maybe FilePath -> Maybe FilePath
stateDirectory system home xdg local = do
  base <- nonempty home
  pure $ case system of
    "macos" -> foldl (Posix.</>) base ["Library","Application Support","semiont"]
    "windows" -> maybe (foldl (Windows.</>) base ["AppData","Local","semiont"]) (Windows.</> "semiont") (nonempty local)
    _ -> maybe (foldl (Posix.</>) base [".local","state","semiont"]) (Posix.</> "semiont") (nonempty xdg)
  where nonempty value = value >>= \text -> if null text then Nothing else Just text
thisSystem :: Text
thisSystem = case System.os of "darwin" -> "macos"; "mingw32" -> "windows"; other -> Text.pack other

readDocument :: SignInStore -> IO Object
readDocument store = do
  content <- (Just <$> Bytes.readFile (path store)) `catch` \failure ->
    if isDoesNotExistError failure then pure Nothing else throwIO (failure::IOException)
  case content of
    Nothing -> pure KM.empty
    Just bytes -> case eitherDecodeStrict' bytes of
      Right (Object document) -> pure document
      _ -> ioError (userError "The sign-in store is not a JSON object; it was not changed")

record :: Value -> Maybe SignIn
record value = case fromJSON value of
  Success parsed | validDate (signInObtainedAt parsed) && maybe True validDate (signInExpiresAt parsed) -> Just parsed
  _ -> Nothing
  where validDate text = case iso8601ParseM (Text.unpack text) :: Maybe UTCTime of Just _ -> True; _ -> False
signIns :: SignInStore -> IO (Map.Map Text SignIn)
signIns store = Map.fromList . map (\(key,value) -> (Key.toText key,value)) . KM.toList . KM.mapMaybe record <$> readDocument store
signIn :: SignInStore -> Text -> IO (Maybe SignIn)
signIn store key = (>>=record) . KM.lookup (Key.fromText key) <$> readDocument store

change :: SignInStore -> (Object -> IO (Maybe Object,result)) -> IO result
change store@(SignInStore options filename turn) transform = withMVar turn $ \() -> do
  let directory=takeDirectory filename
  createDirectoryIfMissing True directory
  Native.withLock (signInStoreTime options) (signInStoreLockRetryMs options) (directory </> Policy.signInLockName) $ do
    Native.ownerOnly directory
    document <- readDocument store
    (next,result) <- transform document
    mapM_ (writeDocument store) next
    pure result

writeDocument :: SignInStore -> Object -> IO ()
writeDocument store document = do
  -- Named here, not by openBinaryTempFile: on Windows that names its file with
  -- GetTempFileNameW, which refuses a directory longer than MAX_PATH.
  suffix <- Char8.unpack . Base64.encodeUnpadded <$> (getRandomBytes 16 :: IO Bytes.ByteString)
  let temporary=path store<>".tmp"<>suffix
      cleanup handle = do
        closed <- hIsClosed handle
        (unless closed (hClose handle)) `finally` (removeFile temporary `catch` \failure ->
          if isDoesNotExistError failure then pure () else throwIO (failure::IOException))
  bracketOnError (openBinaryFile temporary WriteMode) cleanup $ \handle -> do
    Native.fileMode temporary
    Lazy.hPut handle (encode (Object document))
    hFlush handle
    hClose handle
    renameFile temporary (path store)

asStored :: SignIn -> Maybe StoredSession
asStored value = do
  refresh <- signInRefreshToken value
  if Text.null refresh then Nothing else pure (StoredSession (signInToken value) OAuth.scriptClientId Nothing refresh
    (signInRevocationEndpoint value) (signInTokenEndpoint value) KM.empty)

writtenTimes :: SignInStoreOptions -> Text -> IO (Text,Maybe Text)
writtenTimes options access = do
  now <- signInStoreWallNow options
  let format=Text.pack . formatTime defaultTimeLocale "%Y-%m-%dT%H:%M:%SZ"
      expiry = format . posixSecondsToUTCTime . fromInteger . floor <$> Tokens.tokenExpiry access
      obtained = format (posixSecondsToUTCTime (fromInteger (floor (utcTimeToPOSIXSeconds now))))
  pure (obtained,expiry)

stamp :: SignInStoreOptions -> SignIn -> Text -> Text -> IO SignIn
stamp options before access refresh = do
  (obtained,expiry) <- writtenTimes options access
  pure before { signInToken=access, signInRefreshToken=Just refresh,signInObtainedAt=obtained,signInExpiresAt=expiry }

entry :: SignInStore -> Text -> SignIn.KeptSignIn
entry store@(SignInStore options _ _) identity = SignIn.KeptSignIn
  (signIn store identity >>= pure . (>>=asStored))
  (\held -> do
    unless (storedSessionClientId held==OAuth.scriptClientId)
      (throwIO (SignInError SignInExchange "The launcher store keeps only grants of the script client" Nothing))
    issuer <- case Tokens.textClaim (storedSessionAccess held) "iss" of
      Just value | not (Text.null value) -> pure value
      _ -> throwIO (SignInError SignInExchange "The sign-in was not kept: its token names no issuer" Nothing)
    change store $ \document -> do
      (obtained,expiry) <- writtenTimes options (storedSessionAccess held)
      let written=SignIn (Tokens.textClaim (storedSessionAccess held) "email") expiry issuer obtained
            (Just (storedSessionRefresh held)) (storedSessionRevocationEndpoint held) (storedSessionAccess held) (storedSessionTokenEndpoint held) KM.empty
      pure (Just (KM.insert (Key.fromText identity) (toJSON written) document),()))
  (\before issued -> change store $ \document -> do
    let current=KM.lookup (Key.fromText identity) document >>= record
    case current of
      Nothing -> pure (Nothing,Nothing)
      Just original -> case SignIn.rotation (asStored original) before issued of
        SignIn.Gone -> pure (Nothing,Nothing)
        SignIn.AlreadyRenewed access -> pure (Nothing,Just access)
        SignIn.WriteTokens next -> do
          written <- stamp options original (storedSessionAccess next) (storedSessionRefresh next)
          pure (Just (KM.insert (Key.fromText identity) (toJSON written) document),Just (storedSessionAccess next)))
  (change store $ \document -> pure (if KM.member (Key.fromText identity) document
    then Just (KM.delete (Key.fromText identity) document) else Nothing,()))
  (const (pure Nothing))
  -- The launcher's document has no place for a person.
  (\_ _ -> pure False)
