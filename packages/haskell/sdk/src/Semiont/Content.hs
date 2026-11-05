{-# LANGUAGE RankNTypes #-}
module Semiont.Content (ContentTransport(..), BinaryContent(..), ReplayableBody(..), UploadProgress(..), bytesBody) where

import Data.ByteString (ByteString)
import qualified Data.ByteString as Bytes
import Data.Int (Int64)
import Data.IORef
import Data.Text (Text)
import Network.HTTP.Client (GivesPopper)
import Semiont.Types
import Streaming (Of, Stream)

data BinaryContent = BinaryContent { contentType :: Text, contentBytes :: ByteString } deriving (Eq, Show)
data UploadProgress = UploadProgress { bytesUploaded :: Integer, totalBytes :: Integer } deriving (Eq, Show)

-- The callback opens a fresh reader each time and releases it on return.
data ReplayableBody = ReplayableBody { bodyLength :: Maybe Int64, openBody :: GivesPopper () }

bytesBody :: ByteString -> ReplayableBody
bytesBody bytes = ReplayableBody (Just (fromIntegral (Bytes.length bytes))) $ \consume -> do
  remaining <- newIORef bytes
  consume (atomicModifyIORef' remaining (\value -> (Bytes.empty, value)))

data ContentTransport = ContentTransport
  { putBinary :: ResourceUploadMetadata -> ReplayableBody -> (UploadProgress -> IO ()) -> IO ResourceId
  , getBinary :: ResourceId -> IO BinaryContent
  , getBinaryStream :: forall result. ResourceId -> (Text -> Stream (Of ByteString) IO () -> IO result) -> IO result
  , getResourceGraph :: ResourceId -> IO GetResourceResponse
  , getAnnotations :: ResourceId -> IO GetAnnotationsResponse
  , getAnchoredText :: ResourceId -> IO AnchoredTextAnswer
  , dispose :: IO ()
  }
