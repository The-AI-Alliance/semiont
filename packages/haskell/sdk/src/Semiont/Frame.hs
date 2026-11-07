module Semiont.Frame (FrameNamespace, newFrame, addEntityType, addEntityTypes, addTagSchema) where
import Data.Text (Text)
import qualified Semiont.Bus as Bus
import Semiont.Channels
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types

data FrameNamespace = FrameNamespace Bus.Bus Timing.Settings
newFrame :: Bus.Bus -> Timing.Settings -> FrameNamespace
newFrame = FrameNamespace
addEntityType :: FrameNamespace -> Text -> IO EmptyBusPayload
addEntityType (FrameNamespace bus timing) tag = Bus.request bus FrameAddEntityTypeOperation (FrameAddEntityTypeCommand Nothing tag mempty) (Timing.busRequestTimeoutMs timing)
addEntityTypes :: FrameNamespace -> [Text] -> IO [EmptyBusPayload]
addEntityTypes namespace = mapM (addEntityType namespace)
addTagSchema :: FrameNamespace -> TagSchema -> IO EmptyBusPayload
addTagSchema (FrameNamespace bus timing) schema = Bus.request bus FrameAddTagSchemaOperation (FrameAddTagSchemaCommand Nothing schema mempty) (Timing.busRequestTimeoutMs timing)
