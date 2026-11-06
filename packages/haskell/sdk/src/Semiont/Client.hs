module Semiont.Client (Client, newClient, fromHttp, baseUrl, transport, content, wire, bus, frame, bind, beckon, job, auth, system, state, dispose) where

import Control.Exception (onException, finally)
import Data.Text (Text)
import qualified Data.UUID.Types as UUID
import qualified Semiont.Http as Http
import qualified Semiont.Retry as Retry
import qualified Semiont.Bus as Bus
import qualified Semiont.Content as Content
import Semiont.Frame (FrameNamespace, newFrame)
import Semiont.Bind (BindNamespace, newBind)
import Semiont.Beckon (BeckonNamespace, newBeckon)
import Semiont.Job (JobNamespace, newJob)
import qualified Semiont.Timing.Settings as Timing
import Semiont.Auth (AuthNamespace, newAuth)
import Semiont.System (SystemNamespace, newSystem)
import Semiont.Gateway (GatewayOperations)
import qualified Semiont.EventBus as Local
import Semiont.StateValue (StateValue)
import qualified Semiont.Transport as Transport

data Client = Client
  { clientCarrier :: Transport.Transport
  , clientContent :: Content.ContentTransport
  , clientWire :: Bus.Bus
  , clientLocal :: Local.EventBus
  , clientFrame :: FrameNamespace
  , clientBind :: BindNamespace
  , clientBeckon :: BeckonNamespace
  , clientJob :: JobNamespace
  , clientAuth :: Maybe AuthNamespace
  , clientSystem :: Maybe SystemNamespace
  , clientDisconnect :: IO ()
  }

newClient :: Transport.Transport -> Content.ContentTransport -> Maybe GatewayOperations -> Bus.BusOptions -> Timing.Settings -> IO Client
newClient carrier contents gateway options timing = do
  local <- Local.newEventBus
  disconnect <- Transport.bridgeInto carrier local `onException` Local.closeEventBus local
  let typed = Bus.newBus options carrier
  pure (Client carrier contents typed local (newFrame typed timing) (newBind typed local timing) (newBeckon typed local)
    (newJob typed local carrier options timing) (newAuth <$> gateway) (newSystem <$> gateway) disconnect)

fromHttp :: Http.HttpOptions -> IO Client
fromHttp options = do
  http <- Http.newHttpTransport options
  let time = Http.httpTime options
      busOptions = Bus.BusOptions (Retry.retryNow time) (Retry.retryWaitUntil time) (UUID.toText <$> Http.httpNewId options)
  newClient (Http.transport http) (Http.content http) (Just (Http.gateway http)) busOptions (Http.httpTiming options)
    `onException` Http.dispose http

baseUrl :: Client -> Text
baseUrl = Transport.baseUrl . transport

transport :: Client -> Transport.Transport
transport Client { clientCarrier = value } = value
content :: Client -> Content.ContentTransport
content Client { clientContent = value } = value
wire :: Client -> Bus.Bus
wire Client { clientWire = value } = value
bus :: Client -> Local.EventBus
bus Client { clientLocal = value } = value
frame :: Client -> FrameNamespace
frame Client { clientFrame = value } = value
bind :: Client -> BindNamespace
bind Client { clientBind = value } = value
beckon :: Client -> BeckonNamespace
beckon Client { clientBeckon = value } = value
job :: Client -> JobNamespace
job Client { clientJob = value } = value
auth :: Client -> Maybe AuthNamespace
auth Client { clientAuth = value } = value
system :: Client -> Maybe SystemNamespace
system Client { clientSystem = value } = value

state :: Client -> StateValue Transport.ConnectionState
state = Transport.state . transport
dispose :: Client -> IO ()
dispose client =
  Transport.dispose (transport client) `finally` (Content.dispose (content client)
    `finally` (clientDisconnect client `finally` Local.closeEventBus (bus client)))
