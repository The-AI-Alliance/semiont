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
  { putBinary :: Maybe Text -> ResourceUploadMetadata -> ReplayableBody -> (UploadProgress -> IO ()) -> IO ResourceId
  , getBinary :: Maybe Text -> ResourceId -> IO BinaryContent
  , getBinaryStream :: forall result. Maybe Text -> ResourceId -> (Text -> Stream (Of ByteString) IO () -> IO result) -> IO result
  , getResourceGraph :: Maybe Text -> ResourceId -> IO GetResourceResponse
  , getAnnotations :: Maybe Text -> ResourceId -> IO GetAnnotationsResponse
  , getAnchoredText :: Maybe Text -> ResourceId -> IO AnchoredTextAnswer
  , dispose :: IO ()
  }
