module WritableState where
import qualified Semiont.StateValue as State
wrong :: State.StateValue value -> value -> IO ()
wrong state value = State.update state value
