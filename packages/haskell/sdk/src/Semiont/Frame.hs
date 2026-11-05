module Semiont.Frame (FrameNamespace, newFrame, addEntityType, addEntityTypes, addTagSchema) where
import Control.Monad (void)
import Data.Text (Text)
import qualified Semiont.Bus as Bus
import Semiont.Channels
import qualified Semiont.Timing as Timing
import Semiont.Types

data FrameNamespace = FrameNamespace Bus.Bus
newFrame :: Bus.Bus -> FrameNamespace
newFrame = FrameNamespace
addEntityType :: FrameNamespace -> Text -> IO ()
addEntityType (FrameNamespace bus) tag = void (Bus.request bus FrameAddEntityTypeOperation (FrameAddEntityTypeCommand Nothing tag mempty) Timing.busRequestTimeoutMs)
addEntityTypes :: FrameNamespace -> [Text] -> IO ()
addEntityTypes namespace = mapM_ (addEntityType namespace)
addTagSchema :: FrameNamespace -> TagSchema -> IO ()
addTagSchema (FrameNamespace bus) schema = void (Bus.request bus FrameAddTagSchemaOperation (FrameAddTagSchemaCommand Nothing schema mempty) Timing.busRequestTimeoutMs)
