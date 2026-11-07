-- | A client's own in-process signal plane, separate from the transport's wire.
module Semiont.EventBus (EventBus, newEventBus, local, events, closeEventBus) where
import Semiont.Internal.Transport
