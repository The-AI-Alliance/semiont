{-# LANGUAGE OverloadedStrings #-}
-- | Where a client keeps one person's things for a knowledge base
-- (session/stored.json's @cacheKeyPrefix@ and @lastEventIdKeyPrefix@), under
-- the key of the person the gateway named.
module Semiont.Internal.Kept (personKey, cacheKey, lastEventIdKey, forgetKept) where

import Data.Text (Text)
import Semiont.Internal.Digest (sha256Base64Url)
import qualified Semiont.Internal.Generated.Stored as Stored
import Semiont.Internal.Generated.CachePersistence (KeptQuery, keptQueryName)
import qualified Semiont.SessionStorage as Storage

-- | The key of the person a did names.
personKey :: Text -> Text
personKey = sha256Base64Url

cacheKey :: Text -> Text -> KeptQuery -> Text
cacheKey kbId person query = Stored.cacheKeyPrefix<>kbId<>"."<>person<>"."<>keptQueryName query

lastEventIdKey :: Text -> Text -> Text
lastEventIdKey kbId person = Stored.lastEventIdKeyPrefix<>kbId<>"."<>person

-- | Deletes every key of the person on the knowledge base, whether or not each holds anything.
forgetKept :: Storage.SessionStorage -> Text -> Text -> IO ()
forgetKept storage kbId person = do
  mapM_ (Storage.delete storage . cacheKey kbId person) [minBound..maxBound]
  Storage.delete storage (lastEventIdKey kbId person)
