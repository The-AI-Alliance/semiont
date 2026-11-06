-- | A common runtime for wire and in-process carriers. The input handle belongs
-- to the carrier; consumers receive the transport and read-only observations.
module Semiont.Transport
  ( Transport, TransportInput, TransportOptions(..), Frame(..), Carried(..), FrameRefusal(..), carriedChannel, carriedScope, carriedCorrelationId, refusalSaid
  , newTransport, baseUrl, emit, frames, stream, on, state, errors, isSubscribed
  , subscribeToResource, trackReply, bridgeInto, dispose
  , receive, receiveRefusal, setState, subscriptions, reportError
  , ConnectionState(..), connectionStateName, connectionTransitions
  ) where
import Semiont.Internal.Transport
import Semiont.Transport.Facts
