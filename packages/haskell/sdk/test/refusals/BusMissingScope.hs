module BusMissingScope where
import qualified Semiont.Bus as Bus
import Semiont.Channels (Channel(..), ScopeArg(..))
import qualified Streaming.Prelude as Stream
wrong :: Bus.Bus -> IO ()
wrong bus = Bus.frames bus MarkAdded NoScope Stream.effects
