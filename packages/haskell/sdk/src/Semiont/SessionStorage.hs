{-# LANGUAGE OverloadedStrings, RankNTypes #-}
-- | Atomic text storage supplied by an application or a native store.
module Semiont.SessionStorage (SessionStorage(..), newMemoryStorage) where

import Control.Concurrent.STM
import qualified Data.Map.Strict as Map
import Data.Text (Text)

data SessionStorage = SessionStorage
  { get :: Text -> IO (Maybe Text)
  , set :: Text -> Text -> IO ()
  , delete :: Text -> IO ()
  , update :: forall result. Text -> (Maybe Text -> (Maybe Text,result)) -> IO result
  -- ^ Atomically transform a value and return a result from the same read.
  , subscribe :: (Text -> Maybe Text -> IO ()) -> IO (Maybe (IO ()))
  }

-- | One context's memory: no external writer and no external notifications.
newMemoryStorage :: IO SessionStorage
newMemoryStorage = do
  values <- newTVarIO Map.empty
  let change key transform = atomically $ do
        previous <- Map.lookup key <$> readTVar values
        let (next,result) = transform previous
        case next of
          Nothing -> modifyTVar' values (Map.delete key)
          Just value -> modifyTVar' values (Map.insert key value)
        pure result
  pure (SessionStorage
    (\key -> Map.lookup key <$> readTVarIO values)
    (\key value -> change key (const (Just value,())))
    (\key -> change key (const (Nothing,()))) change (const (pure Nothing)))
