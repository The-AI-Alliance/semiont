{-# LANGUAGE OverloadedStrings #-}
module Valid where
import Data.Text (Text)
import qualified Semiont.Channels as Channels
import Semiont.Types (ResourceId, mkResourceId, FrameAddEntityTypeCommand, EmptyBusPayload)
import qualified Data.Text.IO as Text
import Semiont.Discovery (DiscoveryRead, readDiscovery, textDiscovery)
import qualified Semiont.Bus as Bus
import qualified Semiont.Timing as Timing
identifier :: Either String ResourceId
identifier = mkResourceId "probe"
channel :: Text
channel = Channels.channelName Channels.BrowseResourceRequested
discover :: FilePath -> IO DiscoveryRead
discover path = readDiscovery (textDiscovery (Text.readFile path))
ask :: Bus.Bus -> FrameAddEntityTypeCommand -> IO EmptyBusPayload
ask bus payload = Bus.request bus Channels.FrameAddEntityTypeOperation payload Timing.busRequestTimeoutMs
observe :: Bus.Bus -> ResourceId -> IO ()
observe bus resource = Bus.frames bus Channels.MarkAdded (Channels.InScope resource) (const (pure ()))
