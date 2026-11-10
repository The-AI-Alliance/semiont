{-# LANGUAGE OverloadedStrings #-}
-- | Where a knowledge base's stream was (session/stored.json's @lastEventIds@),
-- written only in the same call as a write of a kept cache's document.
module Semiont.Internal.Coupled (Coupled, newCoupled, savePosition, loadPositions, start, written, dispose) where

import Control.Concurrent.MVar (MVar, newMVar, withMVar)
import Control.Concurrent.STM
import Control.Monad (unless, when)
import Data.Aeson (Value(..), encode, eitherDecodeStrict', fromJSON, Result(..))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString.Lazy as Lazy
import qualified Data.Map.Strict as Map
import Data.Maybe (isJust, isNothing)
import Data.Text (Text)
import Data.Text.Encoding (decodeUtf8, encodeUtf8)
import Semiont.Internal.Generated.CachePersistence (lastEventIds)
import qualified Semiont.SessionStorage as Storage
import Semiont.Types (ResourceId, resourceIdValue, PersistedEventId(..))

data Coupled = Coupled
  { storage :: Storage.SessionStorage
  , positionKey :: Text
  , pending :: TVar (Map.Map ResourceId Text)
  , gate :: TVar (Maybe (STM Bool, STM Bool))
  , final :: TVar (Maybe (Map.Map ResourceId Text))
  -- ^ Set once disposal begins: the places its flush writes.
  , writing :: MVar ()
  }

-- | The places kept under @key@ of @underlying@.
newCoupled :: Storage.SessionStorage -> Text -> IO Coupled
newCoupled underlying key = Coupled underlying key
  <$> newTVarIO Map.empty <*> newTVarIO Nothing <*> newTVarIO Nothing <*> newMVar ()

positionsOf :: Maybe Text -> Map.Map ResourceId Text
positionsOf raw=case raw >>= either (const Nothing) Just . eitherDecodeStrict' . encodeUtf8 of
  Just document -> persistedEventIdValue <$> lastEventIds document
  Nothing -> Map.empty
loadPositions :: Coupled -> IO (Map.Map ResourceId Text)
loadPositions coupled=positionsOf <$> Storage.get (storage coupled) (positionKey coupled)
savePosition :: Coupled -> ResourceId -> Text -> IO ()
savePosition coupled scope identity=case fromJSON (String identity) :: Result PersistedEventId of
  Error _ -> pure ()
  Success _ -> atomically $ do
    over <- isJust <$> readTVar (final coupled)
    unless over (modifyTVar' (pending coupled) (Map.insert scope identity))

-- | The gate a place is written under, as what holds it back. @unsettled@: a
-- kept cache has a fetch in flight or owes a save. @dropped@: what disposal
-- drops, a kept cache's fetch in flight or a refetch the refresher owes.
start :: Coupled -> STM Bool -> STM Bool -> IO ()
start coupled unsettled dropped = atomically $ do
  given <- readTVar (gate coupled)
  case given of
    Just _ -> throwSTM (userError "Resumption coupling started twice")
    Nothing -> writeTVar (gate coupled) (Just (unsettled, dropped))

-- | A kept cache's document was written: write the places noted while the
-- gate holds, or once disposal has begun, those it let through. Places that
-- are not written wait for the next document write.
written :: Coupled -> IO ()
written coupled=withMVar (writing coupled) $ \_ -> do
  snapshot <- atomically $ do
    sealed <- readTVar (final coupled)
    case sealed of
      Just values -> pure values
      Nothing -> do
        given <- readTVar (gate coupled)
        held <- case given of
          Nothing -> pure True
          Just (unsettled, dropped) -> (||) <$> unsettled <*> dropped
        if held then pure Map.empty else readTVar (pending coupled)
  unless (Map.null snapshot) $ do
    Storage.update (storage coupled) (positionKey coupled) $ \prior ->
      let merged=Map.union snapshot (positionsOf prior)
          document=Object (KM.fromList [(Key.fromText (resourceIdValue scope),String identity) | (scope,identity)<-Map.toList merged])
      in (Just (decodeUtf8 (Lazy.toStrict (encode document))),())
    let unwritten values=Map.differenceWith (\new old -> if new==old then Nothing else Just new) values snapshot
    atomically $ do
      modifyTVar' (pending coupled) unwritten
      modifyTVar' (final coupled) (fmap unwritten)

-- | Disposal begins. Read before any kept cache or the refresher is disposed:
-- a fetch then in flight or a refetch then owed holds the places back from
-- the disposal's flush, which drops it; a save then owed does not, since the
-- flush is that save.
dispose :: Coupled -> IO ()
dispose coupled=atomically $ do
  sealed <- readTVar (final coupled)
  when (isNothing sealed) $ do
    given <- readTVar (gate coupled)
    held <- case given of
      Nothing -> pure True
      Just (_, dropped) -> dropped
    values <- readTVar (pending coupled)
    writeTVar (final coupled) (Just (if held then Map.empty else values))
