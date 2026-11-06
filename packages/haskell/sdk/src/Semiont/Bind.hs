module Semiont.Bind (BindNamespace, newBind, body, initiate, reportBodyError) where

import Control.Concurrent.STM (STM)
import Control.Monad (void)
import qualified Semiont.Bus as Bus
import Semiont.Channels
import Semiont.EventBus (EventBus)
import qualified Semiont.Internal.Local as Local
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types

data BindNamespace = BindNamespace Bus.Bus EventBus Timing.Settings
newBind :: Bus.Bus -> EventBus -> Timing.Settings -> BindNamespace
newBind = BindNamespace
body :: BindNamespace -> ResourceId -> AnnotationId -> [BindBodyOperation] -> IO ()
body (BindNamespace wire _ timing) resource annotation operations = void $
  Bus.request wire BindUpdateBodyOperation (BindUpdateBodyCommand Nothing annotation operations resource mempty) (Timing.busRequestTimeoutMs timing)
initiate :: BindNamespace -> BindInitiateCommand -> STM ()
initiate (BindNamespace _ bus _) input = Local.signal bus BindInitiate input NoScope
reportBodyError :: BindNamespace -> ResourceErrorEvent -> STM ()
reportBodyError (BindNamespace _ bus _) input = Local.signal bus BindBodyError input NoScope
