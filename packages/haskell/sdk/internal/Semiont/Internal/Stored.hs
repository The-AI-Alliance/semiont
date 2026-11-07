{-# LANGUAGE OverloadedStrings #-}
-- | The shared storage keys and stored sign-in document of a registry.
module Semiont.Internal.Stored
  ( StoredSession(..), knowledgeBasesKey, activeKey, openResourcesByKbKey
  , lastViewedResourceByKbKey, sessionKey, storedSession, storeSession, clearStoredSession, kbOfSessionKey, loadKnowledgeBases, saveKnowledgeBases, projectKnowledgeBase
  ) where
import Data.Aeson (Value(..), fromJSON, Result(..), eitherDecodeStrict', encode)
import qualified Data.Aeson.KeyMap as KM
import Data.Foldable (toList)
import Data.Maybe (mapMaybe)
import qualified Data.ByteString.Lazy as Lazy
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import Semiont.Types (StoredSession(..), KnowledgeBase(..), KbEndpoint(..), HttpEndpoint(..), LocalEndpoint(..), KbRead(..))
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

kbOfSessionKey :: Text -> Maybe Text
kbOfSessionKey key=Text.stripPrefix Stored.sessionKeyPrefix key >>= \identity -> if Text.null identity then Nothing else Just identity

projectKnowledgeBase :: KnowledgeBase -> KnowledgeBase
projectKnowledgeBase kb=kb { knowledgeBaseAdditionalProperties=KM.empty
  , knowledgeBaseEndpoint=case knowledgeBaseEndpoint kb of
      KbEndpointBranch1 endpoint -> KbEndpointBranch1 endpoint { httpEndpointAdditionalProperties=KM.empty }
      KbEndpointBranch2 endpoint -> KbEndpointBranch2 endpoint { localEndpointAdditionalProperties=KM.empty }
  , knowledgeBaseLastRead=fmap (\readBack -> readBack { kbReadAdditionalProperties=KM.empty }) (knowledgeBaseLastRead kb) }

loadKnowledgeBases :: SessionStorage -> IO [KnowledgeBase]
loadKnowledgeBases storage = do
  raw <- get storage knowledgeBasesKey
  pure $ case raw >>= either (const Nothing) Just . eitherDecodeStrict' . encodeUtf8 of
    Just (Array entries) -> mapMaybe (\value -> case fromJSON value of Success parsed->Just (projectKnowledgeBase parsed); Error _->Nothing) (toList entries)
    _ -> []
saveKnowledgeBases :: SessionStorage -> [KnowledgeBase] -> IO ()
saveKnowledgeBases storage values=set storage knowledgeBasesKey (decodeUtf8 (Lazy.toStrict (encode (map projectKnowledgeBase values))))
