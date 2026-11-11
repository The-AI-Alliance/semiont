{-# LANGUAGE OverloadedStrings #-}
-- | The shared storage keys and stored sign-in document of a registry.
module Semiont.Internal.Stored
  ( StoredSession(..), knowledgeBasesKey, activeKey, openResourcesByKbKey
  , lastViewedResourceByKbKey, sessionKey, storedSession, storeSession, clearStoredSession, kbOfSessionKey, loadKnowledgeBases, saveKnowledgeBases, projectKnowledgeBase
  , swapStoredSession, takeStoredSession, forgetNamed, recordPersonKey, recording
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
import Semiont.Internal.Kept (forgetKept)

sessionKey :: Text -> Text
sessionKey = (Stored.sessionKeyPrefix <>)
decoded :: Text -> Maybe StoredSession
decoded = either (const Nothing) Just . eitherDecodeStrict' . encodeUtf8
encoded :: StoredSession -> Text
encoded = decodeUtf8 . Lazy.toStrict . encode

storedSession :: SessionStorage -> Text -> IO (Maybe StoredSession)
storedSession storage identity = (>>= decoded) <$> get storage (sessionKey identity)

-- | A new sign-in names nobody until its gateway names them, so the person
-- the one it replaces named is forgotten, even when it turns out to be theirs.
storeSession :: SessionStorage -> Text -> StoredSession -> IO ()
storeSession storage identity grant = swapStoredSession storage identity grant >>= forgetNamed storage identity
clearStoredSession :: SessionStorage -> Text -> IO ()
clearStoredSession storage identity = takeStoredSession storage identity >>= forgetNamed storage identity

-- | Keeps a sign-in in place of the one kept, and answers the one it replaced.
swapStoredSession :: SessionStorage -> Text -> StoredSession -> IO (Maybe StoredSession)
swapStoredSession storage identity grant = update storage (sessionKey identity) (\raw -> (Just (encoded grant), raw >>= decoded))
-- | Deletes the sign-in kept, and answers it.
takeStoredSession :: SessionStorage -> Text -> IO (Maybe StoredSession)
takeStoredSession storage identity = update storage (sessionKey identity) (\raw -> (Nothing, raw >>= decoded))
-- | Forgets what was kept for the person a replaced or deleted sign-in named.
forgetNamed :: SessionStorage -> Text -> Maybe StoredSession -> IO ()
forgetNamed storage identity previous = mapM_ (forgetKept storage identity) (previous >>= storedSessionPersonKey)

-- | A sign-in recording who the gateway said its token is: the sign-in to
-- keep in its place, if it changes, and whether it then names that person.
-- It records only while it holds that token and names nobody.
recording :: Text -> Text -> StoredSession -> (Maybe StoredSession, Bool)
recording access person held
  | storedSessionAccess held /= access = (Nothing, False)
  | otherwise = case storedSessionPersonKey held of
      Nothing -> (Just held { storedSessionPersonKey = Just person }, True)
      Just named -> (Nothing, named == person)

recordPersonKey :: SessionStorage -> Text -> Text -> Text -> IO Bool
recordPersonKey storage identity access person = do
  held <- storedSession storage identity
  case fmap (recording access person) held of
    Just (Just _, _) -> update storage (sessionKey identity) $ \raw -> case fmap (recording access person) (raw >>= decoded) of
      Just (Just named, answer) -> (Just (encoded named), answer)
      Just (Nothing, answer) -> (raw, answer)
      Nothing -> (raw, False)
    Just (Nothing, answer) -> pure answer
    Nothing -> pure False

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
