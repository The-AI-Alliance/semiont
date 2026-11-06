{-# LANGUAGE OverloadedStrings, RankNTypes #-}
module Semiont.Internal.Coupled (Coupled, newCoupled, storage, savePosition, loadPositions, start, dispose) where

import Control.Concurrent.STM
import Control.Monad (unless, void, when, forever)
import Data.Aeson (Value(..), encode, eitherDecodeStrict', fromJSON, Result(..))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString.Lazy as Lazy
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (decodeUtf8, encodeUtf8)
import qualified Semiont.Internal.Lifetime as Lifetime
import qualified Semiont.Internal.Generated.Stored as Stored
import qualified Semiont.SessionStorage as Storage
import Semiont.Http.Routes (persistedScopePrefix)
import Semiont.Types (ResourceId, resourceIdValue, mkResourceId, PersistedEventId)

data Coupled = Coupled
  { storage :: Storage.SessionStorage
  , original :: Storage.SessionStorage
  , positionKey :: Text
  , pending :: TVar (Map.Map ResourceId Text)
  , documents :: TVar Integer
  , closed :: TVar Bool
  , started :: TVar Bool
  , lifetime :: Lifetime.Lifetime
  }

newCoupled :: Storage.SessionStorage -> Text -> IO Coupled
newCoupled underlying prefix = do
  held <- newTVarIO Map.empty
  written <- newTVarIO 0
  stopped <- newTVarIO False
  running <- newTVarIO False
  life <- Lifetime.newLifetime "resumption coupling is closed"
  let cachePrefix=Stored.cacheKeyPrefix<>prefix<>"."
      note key=when (cachePrefix `Text.isPrefixOf` key) (atomically (modifyTVar' written (+1)))
      change key transform = do
        result <- Storage.update underlying key transform
        note key
        pure result
      wrapped=underlying
        { Storage.set= \key value -> Storage.set underlying key value >> note key
        , Storage.update=change
        }
  pure (Coupled wrapped underlying (Stored.lastEventIdKeyPrefix<>prefix) held written stopped running life)

positionsOf :: Maybe Text -> Map.Map ResourceId Text
positionsOf raw=case raw >>= either (const Nothing) Just . eitherDecodeStrict' . encodeUtf8 of
  Just (Object fields) -> Map.fromList [(scope,identity) | (key,String identity)<-KM.toList fields,
    Right scope<-[mkResourceId (Key.toText key)],validPosition scope identity]
  _ -> Map.empty
validPosition :: ResourceId -> Text -> Bool
validPosition scope identity=case fromJSON (String identity) :: Result PersistedEventId of
  Success _ -> (persistedScopePrefix scope) `Text.isPrefixOf` identity
  Error _ -> False
loadPositions :: Coupled -> IO (Map.Map ResourceId Text)
loadPositions coupled=positionsOf <$> Storage.get (original coupled) (positionKey coupled)
savePosition :: Coupled -> ResourceId -> Text -> IO ()
savePosition coupled scope identity=when (validPosition scope identity) $ atomically $ do
  over <- readTVar (closed coupled)
  unless over (modifyTVar' (pending coupled) (Map.insert scope identity))

-- Only a cache-document write can advance bookmarks. Its revision remains
-- available while saves/refetches are pending, so the last save need not call
-- back after it has returned to its cache and cleared that cache's dirty bit.
start :: Coupled -> STM Bool -> IO ()
start coupled quiet = do
  atomically $ do
    already <- readTVar (started coupled)
    when already (throwSTM (userError "Resumption coupling started twice"))
    writeTVar (started coupled) True
  acknowledged <- newTVarIO 0
  void $ Lifetime.start (lifetime coupled) $ forever $ do
    (version,snapshot) <- atomically $ do
      over <- readTVar (closed coupled)
      check (not over)
      revision <- readTVar (documents coupled)
      before <- readTVar acknowledged
      check (revision>before)
      values <- readTVar (pending coupled)
      check (not (Map.null values))
      settled <- quiet
      check settled
      pure (revision,values)
    Storage.update (original coupled) (positionKey coupled) $ \prior ->
      let merged=Map.union snapshot (positionsOf prior)
          document=Object (KM.fromList [(Key.fromText (resourceIdValue scope),String identity) | (scope,identity)<-Map.toList merged])
      in (Just (decodeUtf8 (Lazy.toStrict (encode document))),())
    atomically $ do
      modifyTVar' (pending coupled) (\values -> Map.differenceWith (\new old -> if new==old then Nothing else Just new) values snapshot)
      writeTVar acknowledged version

dispose :: Coupled -> IO ()
dispose coupled=atomically (writeTVar (closed coupled) True) >> Lifetime.close (lifetime coupled)
