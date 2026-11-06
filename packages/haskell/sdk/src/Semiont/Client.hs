module Semiont.Client (Client, newClient, fromHttp, baseUrl, transport, content, wire, bus, frame, bind, beckon, browse, gather, match, job, auth, system, state, dispose) where

import Control.Exception (onException, finally, bracketOnError)
import Control.Monad (unless)
import Data.List (sort)
import qualified Semiont.Internal.Browse as Browse
import qualified Semiont.Internal.Gather as Gather
import qualified Semiont.Internal.Match as Match
import qualified Semiont.Internal.Refresh as Refresh
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
  , clientBrowse :: Browse.BrowseNamespace
  , clientGather :: Gather.GatherNamespace
  , clientMatch :: Match.MatchNamespace
  , clientRefresh :: Refresh.Refresher
  , clientJob :: JobNamespace
  , clientAuth :: Maybe AuthNamespace
  , clientSystem :: Maybe SystemNamespace
  , clientDisconnect :: IO ()
  }

newClient :: Transport.Transport -> Content.ContentTransport -> Maybe GatewayOperations -> Bus.BusOptions -> Timing.Settings -> IO Client
newClient carrier contents gateway options timing =
  bracketOnError Local.newEventBus Local.closeEventBus $ \local ->
  bracketOnError (Transport.bridgeInto carrier local) id $ \disconnect -> do
    let typed = Bus.newBus options carrier
    bracketOnError (Browse.newBrowse typed local carrier contents options timing) Browse.dispose $ \browseQueries ->
      bracketOnError (Gather.newGather typed carrier options timing) Gather.dispose $ \gatherQueries ->
      bracketOnError (Match.newMatch typed local options timing) Match.dispose $ \matchQueries -> do
        let controls = Browse.controls browseQueries ++ Gather.controls gatherQueries ++ Match.controls matchQueries
        unless (sort (map fst controls) == [minBound..maxBound]) (ioError (userError "the client does not own every refresh-table query exactly once"))
        refresher <- Refresh.newRefresher local carrier options timing controls
        pure (Client carrier contents typed local (newFrame typed timing) (newBind typed local timing) (newBeckon typed local)
          browseQueries gatherQueries matchQueries refresher (newJob typed local carrier options timing) (newAuth <$> gateway) (newSystem <$> gateway) disconnect)


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
browse :: Client -> Browse.BrowseNamespace
browse Client { clientBrowse = value } = value
gather :: Client -> Gather.GatherNamespace
gather Client { clientGather = value } = value
match :: Client -> Match.MatchNamespace
match Client { clientMatch = value } = value

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
  Refresh.dispose (clientRefresh client) `finally` (Browse.dispose (browse client)
    `finally` Gather.dispose (gather client) `finally` Match.dispose (match client)
    `finally` Transport.dispose (transport client)) `finally` (Content.dispose (content client)
    `finally` (clientDisconnect client `finally` Local.closeEventBus (bus client)))
