module Semiont.Client (Client, newClient, fromHttp, baseUrl, transport, content, wire, bus, frame, auth, system, state, dispose) where

import Control.Exception (onException, finally)
import Data.Text (Text)
import qualified Data.UUID.Types as UUID
import qualified Semiont.Http as Http
import qualified Semiont.Retry as Retry
import qualified Semiont.Bus as Bus
import qualified Semiont.Content as Content
import Semiont.Frame (FrameNamespace, newFrame)
import Semiont.Auth (AuthNamespace, newAuth)
import Semiont.System (SystemNamespace, newSystem)
import Semiont.Gateway (GatewayOperations)
import qualified Semiont.EventBus as Local
import Semiont.StateValue (StateValue)
import qualified Semiont.Transport as Transport

data Client = Client Transport.Transport Content.ContentTransport Bus.Bus Local.EventBus FrameNamespace (Maybe AuthNamespace) (Maybe SystemNamespace) (IO ())

newClient :: Transport.Transport -> Content.ContentTransport -> Maybe GatewayOperations -> Bus.BusOptions -> IO Client
newClient carrier contents gateway options = do
  local <- Local.newEventBus
  detach <- Transport.bridgeInto carrier local `onException` Local.closeEventBus local
  let typed = Bus.newBus options carrier
  pure (Client carrier contents typed local (newFrame typed) (newAuth <$> gateway) (newSystem <$> gateway) detach)

fromHttp :: Http.HttpOptions -> IO Client
fromHttp options = do
  http <- Http.newHttpTransport options
  let time = Http.httpTime options
      busOptions = Bus.BusOptions (Retry.retryNow time) (Retry.retryWaitUntil time) (UUID.toText <$> Http.httpNewId options)
  newClient (Http.transport http) (Http.content http) (Just (Http.gateway http)) busOptions
    `onException` Http.dispose http

baseUrl :: Client -> Text
baseUrl = Transport.baseUrl . transport

transport :: Client -> Transport.Transport
transport (Client carrier _ _ _ _ _ _ _) = carrier
content :: Client -> Content.ContentTransport
content (Client _ contents _ _ _ _ _ _) = contents
wire :: Client -> Bus.Bus
wire (Client _ _ typed _ _ _ _ _) = typed
bus :: Client -> Local.EventBus
bus (Client _ _ _ local _ _ _ _) = local
frame :: Client -> FrameNamespace
frame (Client _ _ _ _ namespace _ _ _) = namespace
auth :: Client -> Maybe AuthNamespace
auth (Client _ _ _ _ _ namespace _ _) = namespace
system :: Client -> Maybe SystemNamespace
system (Client _ _ _ _ _ _ namespace _) = namespace
state :: Client -> StateValue Transport.ConnectionState
state = Transport.state . transport
dispose :: Client -> IO ()
dispose client@(Client _ _ _ _ _ _ _ detach) =
  Transport.dispose (transport client) `finally` (Content.dispose (content client)
    `finally` (detach `finally` Local.closeEventBus (bus client)))
