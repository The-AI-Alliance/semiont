module Semiont.Internal.StateValue
  ( StateValue, newStateValue, current, watch, update, complete ) where

import Control.Concurrent.STM
import Control.Monad.IO.Class (liftIO)
import qualified Semiont.Internal.Broadcast as Broadcast
import Streaming (Of, Stream)
import qualified Streaming.Prelude as Stream

data StateValue value = StateValue (TVar value) (Broadcast.Broadcast value) (TVar Bool)

newStateValue :: value -> STM (StateValue value)
newStateValue value = StateValue <$> newTVar value <*> Broadcast.newState value <*> newTVar False

current :: StateValue value -> STM value
current (StateValue cell _ _) = readTVar cell

update :: StateValue value -> value -> STM ()
update (StateValue cell broadcast stopped) value = do
  over <- readTVar stopped
  if over then pure () else writeTVar cell value >> Broadcast.publish broadcast value

complete :: StateValue value -> STM ()
complete (StateValue _ broadcast stopped) = writeTVar stopped True >> Broadcast.close broadcast

watch :: StateValue value -> (Stream (Of value) IO () -> IO result) -> IO result
watch (StateValue _ broadcast _) consume = Broadcast.withSubscription broadcast $ \reader ->
  let loop = do
        value <- liftIO (atomically (Broadcast.next reader))
        case value of Nothing -> pure (); Just next -> Stream.yield next >> loop
  in consume loop
