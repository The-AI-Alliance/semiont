module DelegateWrongResult where
import Semiont.Client (Client, yield)
import Semiont.Delegation (JobEvent)
import Semiont.Running (Running)
import Semiont.Types (GenerationJobParams, MarkJobCompleteCommand)
import qualified Semiont.Yield as Yield
bad :: Client -> GenerationJobParams -> IO (Running (JobEvent MarkJobCompleteCommand) MarkJobCompleteCommand)
bad client params = Yield.delegate (yield client) params Nothing
