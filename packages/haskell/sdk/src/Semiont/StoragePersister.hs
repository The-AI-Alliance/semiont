{-# LANGUAGE OverloadedStrings #-}
-- | A kept query's cache document, session/stored.json's @cacheDocument@, over
-- the host's atomic storage, bounded by its UTF-8 byte cap.
module Semiont.StoragePersister (StoragePersister(..), newStoragePersister) where

import Control.Concurrent.MVar (newMVar, modifyMVar)
import Control.Monad (when)
import Data.Aeson (FromJSON, ToJSON, Value, toJSON, encode, eitherDecodeStrict', fromJSON, Result(..))
import Data.Aeson.Types (Parser, parseEither)
import qualified Data.ByteString.Lazy as Lazy
import Data.List (sortOn)
import qualified Data.Map.Strict as Map
import Data.Scientific (Scientific)
import Data.Text (Text)
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import qualified Semiont.Internal.Cache as Cache
import qualified Semiont.SessionStorage as Storage
import Semiont.Internal.Generated.CachePersistence (CacheDocument(..))

data StoragePersister = StoragePersister
  { persisterStorage :: Storage.SessionStorage
  , persisterStorageKey :: Text
  , persisterMaxBytes :: Integer
  , persisterWallNow :: IO Scientific
  -- ^ Epoch milliseconds from the host's clock, rounded to a whole number for
  -- each stamp. An entry whose value is unchanged keeps its stamp.
  , persisterSaved :: IO ()
  -- ^ Run after each save its cache has recorded.
  }

-- | A restored key may need a routing hint from its value. For ordinary keys
-- pass @\key _ -> parseJSON key@. A document whose structure is not a cache
-- document's keeps nothing; an entry whose key or value does not decode is
-- skipped.
newStoragePersister :: (ToJSON key, ToJSON value, FromJSON value)
  => StoragePersister -> (Value -> value -> Parser key) -> IO (Cache.CachePersister key value)
newStoragePersister options decodeKey = do
  when (persisterMaxBytes options<0) (ioError (userError "Negative persisted-document byte cap"))
  stamps <- newMVar Map.empty
  let keyId=decodeUtf8 . Lazy.toStrict . Cache.canonical
      entriesOf raw=case eitherDecodeStrict' (encodeUtf8 raw) of
        Left _ -> []
        Right (CacheDocument entries) -> [(identity,parsed,key,value,at) | (key,value,at)<-entries,
          Success parsed<-[fromJSON value], Right identity<-[parseEither (decodeKey key) parsed]]
      load = modifyMVar stamps $ \_ -> do
        raw <- Storage.get (persisterStorage options) (persisterStorageKey options)
        let kept=maybe [] entriesOf raw
        pure (Map.fromList [(keyId key,(encode value,at)) | (_,_,key,value,at)<-kept],[(identity,parsed) | (identity,parsed,_,_,_)<-kept])
      save values = modifyMVar stamps $ \previous -> do
        now <- round <$> persisterWallNow options
        let records=[let encoded=toJSON value; identity=toJSON key
                         at=case Map.lookup (keyId identity) previous of Just (prior,stamp) | prior==encode encoded -> stamp; _->now
                     in (identity,encoded,at) | (key,value)<-values]
            bytes entries=encode (CacheDocument entries)
            fit entries | toInteger (Lazy.length (bytes entries))<=persisterMaxBytes options = entries
                        | otherwise=case entries of []->[]; _:rest->fit rest
            retained=if toInteger (Lazy.length (bytes records))<=persisterMaxBytes options then records else fit (sortOn (\(_,_,at)->at) records)
        Storage.set (persisterStorage options) (persisterStorageKey options) (decodeUtf8 (Lazy.toStrict (bytes retained)))
        pure (Map.fromList [(keyId key,(encode value,at)) | (key,value,at)<-retained],())
  pure (Cache.CachePersister load save (persisterSaved options))
