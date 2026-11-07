module WorkerWrongResult where
import qualified Semiont.Worker as Worker
import Semiont.Types (MarkJobResult, YieldJobResult)

wrongResult :: Worker.HeldJob MarkJobResult -> YieldJobResult -> IO ()
wrongResult = Worker.complete
