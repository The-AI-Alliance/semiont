{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.SignIn (KeptSignIn(..), Rotation(..), rotation, newMemorySignIn, keptIn, renewKept) where

import Control.Concurrent.Async (wait, waitCatch)
import Control.Concurrent.STM
import Control.Exception (mask, onException)
import Control.Monad (when)
import Data.Aeson (eitherDecodeStrict', encode)
import qualified Data.ByteString.Lazy as Lazy
import Data.Text (Text)
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import OpenTelemetry.Context.ThreadLocal.Propagation (tracedAsync)
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.Internal.Stored as Stored
import Semiont.Types (StoredSession(..), IssuedTokens(..))

data KeptSignIn = KeptSignIn
  { held :: IO (Maybe StoredSession)
  , keep :: StoredSession -> IO ()
  , renewed :: StoredSession -> IssuedTokens -> IO (Maybe Text)
  , forget :: IO ()
  , subscribe :: (Maybe StoredSession -> IO ()) -> IO (Maybe (IO ()))
  , recordPersonKey :: Text -> Text -> IO Bool
  -- ^ Records the key of the person the gateway said a token is, while the
  -- sign-in still holds that token and names nobody: whether it then names
  -- that person. A sign-in with no place for a person answers False.
  }

data Rotation = Gone | AlreadyRenewed Text | WriteTokens StoredSession
rotation :: Maybe StoredSession -> StoredSession -> IssuedTokens -> Rotation
rotation Nothing _ _ = Gone
rotation (Just current) before issued
  | storedSessionAccess current/=storedSessionAccess before || storedSessionRefresh current/=storedSessionRefresh before = AlreadyRenewed (storedSessionAccess current)
  | otherwise = WriteTokens current { storedSessionAccess=issuedTokensAccess issued,storedSessionRefresh=issuedTokensRefresh issued }

newMemorySignIn :: IO KeptSignIn
newMemorySignIn = do
  value <- newTVarIO Nothing
  pure (KeptSignIn (readTVarIO value) (atomically . writeTVar value . Just)
    (\before issued -> atomically $ do
      current <- readTVar value
      case rotation current before issued of
        Gone -> pure Nothing
        AlreadyRenewed access -> pure (Just access)
        WriteTokens next -> writeTVar value (Just next) >> pure (Just (storedSessionAccess next)))
    (atomically (writeTVar value Nothing)) (const (pure Nothing))
    (\access person -> atomically $ do
      current <- readTVar value
      case Stored.recording access person <$> current of
        Just (named, answer) -> mapM_ (writeTVar value . Just) named >> pure answer
        Nothing -> pure False))

keptIn :: Storage.SessionStorage -> Text -> KeptSignIn
keptIn storage identity = KeptSignIn (Stored.storedSession storage identity) (Stored.storeSession storage identity)
  (\before issued -> Storage.update storage (Stored.sessionKey identity) $ \raw ->
    let current=raw >>= either (const Nothing) Just . eitherDecodeStrict' . encodeUtf8
    in case rotation current before issued of
      Gone -> (raw,Nothing)
      AlreadyRenewed access -> (raw,Just access)
      WriteTokens next -> (Just (decodeUtf8 (Lazy.toStrict (encode next))),Just (storedSessionAccess next)))
  (Stored.clearStoredSession storage identity)
  (\observe -> Storage.subscribe storage $ \key raw -> when (key==Stored.sessionKey identity) $ case raw of
    Nothing -> observe Nothing
    Just text -> case eitherDecodeStrict' (encodeUtf8 text) of Left _ -> pure (); Right value -> observe (Just value))
  (Stored.recordPersonKey storage identity)

-- | A replacement already kept is used before spending a refresh token. The
-- writer compares both read tokens afterwards, preserving renewal/sign-out.
-- An issuer that rotates refresh tokens spends the old one when it answers:
-- once asked, the exchange and the write of what it brought run to their end,
-- and a caller interrupted meanwhile waits for that end before it is.
renewKept :: KeptSignIn -> Maybe Text -> (Text -> IO Bool) -> (StoredSession -> IO IssuedTokens) -> IO (Maybe Text)
renewKept store holding expired issue = do
  current <- held store
  case current of
    Nothing -> pure Nothing
    Just before -> do
      stale <- expired (storedSessionAccess before)
      if Just (storedSessionAccess before)/=holding && not stale then pure (Just (storedSessionAccess before)) else
        mask $ \restore -> do
          spending <- tracedAsync (restore (issue before >>= renewed store before))
          restore (wait spending) `onException` waitCatch spending
