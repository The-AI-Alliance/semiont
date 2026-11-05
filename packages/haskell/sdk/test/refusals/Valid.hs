{-# LANGUAGE OverloadedStrings #-}
module Valid where
import Data.Text (Text)
import qualified Semiont.Channels as Channels
import Semiont.Types (ResourceId, mkResourceId)
identifier :: Either String ResourceId
identifier = mkResourceId "probe"
channel :: Text
channel = Channels.channelName Channels.BrowseResourceRequested
