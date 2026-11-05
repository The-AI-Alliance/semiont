{-# LANGUAGE OverloadedStrings #-}
module Valid where
import Data.Text (Text)
import qualified Semiont.Channels as Channels
import Semiont.Types (ResourceId, mkResourceId)
import qualified Data.Text.IO as Text
import Semiont.Discovery (DiscoveryRead, readDiscovery, textDiscovery)
identifier :: Either String ResourceId
identifier = mkResourceId "probe"
channel :: Text
channel = Channels.channelName Channels.BrowseResourceRequested
discover :: FilePath -> IO DiscoveryRead
discover path = readDiscovery (textDiscovery (Text.readFile path))
