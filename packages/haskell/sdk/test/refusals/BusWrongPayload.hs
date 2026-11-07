module BusWrongPayload where
import qualified Semiont.Bus as Bus
import Semiont.Channels (Channel(..), ScopeArg(..))
import Semiont.Types (BrowseResourceRequest)
wrong :: Bus.Bus -> BrowseResourceRequest -> IO (Maybe Integer)
wrong bus payload = Bus.emit bus BeckonFocus payload NoScope Nothing
