module Semiont.Bus
  ( Bus, BusOptions(..), newBus, emit, frames, request
  , Delivered(..), FrameRefusal(..), Heard(..), Carried(..), Fault(..), FaultReason(..)
  , replyChannelsFor, unsubscribed, persistedEventTypes
  ) where
import Semiont.Internal.Bus
