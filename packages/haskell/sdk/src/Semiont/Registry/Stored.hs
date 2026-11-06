{-# LANGUAGE OverloadedStrings #-}
-- | The shared storage keys and stored sign-in document of a registry.
module Semiont.Registry.Stored
  ( StoredSession(..), knowledgeBasesKey, activeKey, openResourcesByKbKey
  , lastViewedResourceByKbKey, sessionKey, storedSession, storeSession, clearStoredSession
  ) where
import Data.Aeson (eitherDecodeStrict', encode)
import qualified Data.ByteString.Lazy as Lazy
import Data.Text (Text)
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import Semiont.Types (StoredSession(..))
import Semiont.SessionStorage (SessionStorage(..))
import Semiont.Internal.Generated.Stored (knowledgeBasesKey, activeKey, openResourcesByKbKey, lastViewedResourceByKbKey)
import qualified Semiont.Internal.Generated.Stored as Stored

sessionKey :: Text -> Text
sessionKey = (Stored.sessionKeyPrefix <>)
storedSession :: SessionStorage -> Text -> IO (Maybe StoredSession)
storedSession storage identity = do
  value <- get storage (sessionKey identity)
  pure (value >>= either (const Nothing) Just . eitherDecodeStrict' . encodeUtf8)
storeSession :: SessionStorage -> Text -> StoredSession -> IO ()
storeSession storage identity = set storage (sessionKey identity) . decodeUtf8 . Lazy.toStrict . encode
clearStoredSession :: SessionStorage -> Text -> IO ()
clearStoredSession storage identity = delete storage (sessionKey identity)
