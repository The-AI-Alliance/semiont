{-# LANGUAGE RankNTypes #-}
-- | Distinct contexts on one atomic store; a context hears other writers.
module Semiont.Testing.Storage (SharedStorage, newSharedStorage, context, storage) where

import Control.Concurrent.STM
import Control.Monad (forM_)
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import qualified Semiont.SessionStorage as Storage

data Shared = Shared (TVar (Map.Map Text Text)) (TVar Integer) (TVar (Map.Map Integer (Integer,Text -> Maybe Text -> IO ())))
data SharedStorage = SharedStorage Shared Integer
newSharedStorage :: IO SharedStorage
newSharedStorage = atomically $ do
  shared <- Shared <$> newTVar Map.empty <*> newTVar 0 <*> newTVar Map.empty
  pure (SharedStorage shared 0)
context :: SharedStorage -> IO SharedStorage
context (SharedStorage shared@(Shared _ serial _) _) = atomically $ do
  modifyTVar' serial (+1)
  SharedStorage shared <$> readTVar serial
storage :: SharedStorage -> Storage.SessionStorage
storage (SharedStorage (Shared values serial listeners) own) = Storage.SessionStorage
  { Storage.get= \key -> Map.lookup key <$> readTVarIO values
  , Storage.set= \key value -> change key (const (Just value,()))
  , Storage.delete= \key -> change key (const (Nothing,()))
  , Storage.update=change
  , Storage.subscribe= \callback -> do
      subscription <- atomically $ do
        modifyTVar' serial (+1)
        key <- readTVar serial
        modifyTVar' listeners (Map.insert key (own,callback))
        pure key
      pure (Just (atomically (modifyTVar' listeners (Map.delete subscription))))
  }
  where
    change :: Text -> (Maybe Text -> (Maybe Text,result)) -> IO result
    change key transform = do
      (after,result,callbacks) <- atomically $ do
        previous <- Map.lookup key <$> readTVar values
        let (after,result)=transform previous
        modifyTVar' values (maybe (Map.delete key) (Map.insert key) after)
        callbacks <- filter ((/=own) . fst) . Map.elems <$> readTVar listeners
        pure (after,result,map snd callbacks)
      forM_ callbacks (\callback -> callback key after)
      pure result
