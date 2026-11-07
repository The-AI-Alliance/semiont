module Semiont.Client (Client, CachePersistence(..), newClient, fromHttp, baseUrl, transport, content, wire, bus, frame, bind, beckon, browse, gather, match, mark, yield, job, auth, system, state, dispose) where

import Control.Exception (onException, finally, bracketOnError)
import Control.Monad (unless)
import Data.List (sort)
import qualified Semiont.Internal.Browse as Browse
import qualified Semiont.Internal.Gather as Gather
import qualified Semiont.Internal.Match as Match
import qualified Semiont.Internal.Mark as Mark
import qualified Semiont.Internal.Yield as Yield
import qualified Semiont.Internal.Delegation as Delegation
import qualified Semiont.Internal.Refresh as Refresh
import Semiont.Internal.Persistence (CachePersistence(..))
import qualified Semiont.Internal.Coupled as Coupled
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
  , clientMark :: Mark.MarkNamespace
  , clientYield :: Yield.YieldNamespace
  , clientFollower :: Delegation.Follower
  , clientRefresh :: Refresh.Refresher
  , clientJob :: JobNamespace
  , clientAuth :: Maybe AuthNamespace
  , clientSystem :: Maybe SystemNamespace
  , clientCoupled :: Maybe Coupled.Coupled
  , clientDisconnect :: IO ()
  }

newClient :: Transport.Transport -> Content.ContentTransport -> Maybe GatewayOperations -> Bus.BusOptions -> Timing.Settings -> Maybe CachePersistence -> IO Client
newClient carrier contents gateway options timing persistence = do
  ownedPersistence <- preparePersistence persistence
  construct carrier contents gateway options timing ownedPersistence
    `onException` mapM_ (Coupled.dispose . snd) ownedPersistence

preparePersistence :: Maybe CachePersistence -> IO (Maybe (CachePersistence,Coupled.Coupled))
preparePersistence = traverse (\config -> (,) config <$> Coupled.newCoupled (cacheStorage config) (cachePrefix config))

construct :: Transport.Transport -> Content.ContentTransport -> Maybe GatewayOperations -> Bus.BusOptions -> Timing.Settings -> Maybe (CachePersistence,Coupled.Coupled) -> IO Client
construct carrier contents gateway options timing ownedPersistence =
  bracketOnError Local.newEventBus Local.closeEventBus $ \local ->
  bracketOnError (Transport.bridgeInto carrier local) id $ \disconnect -> do
    let typed = Bus.newBus options carrier
    bracketOnError (Delegation.newFollower typed local options timing) Delegation.dispose $ \follower ->
      bracketOnError (Browse.newBrowse typed local carrier contents options timing ownedPersistence) Browse.dispose $ \browseQueries ->
        bracketOnError (Gather.newGather typed carrier options timing) Gather.dispose $ \gatherQueries ->
        bracketOnError (Match.newMatch typed local options timing) Match.dispose $ \matchQueries -> do
          let controls = Browse.controls browseQueries ++ Gather.controls gatherQueries ++ Match.controls matchQueries
          unless (sort (map fst controls) == [minBound..maxBound]) (ioError (userError "the client does not own every refresh-table query exactly once"))
          bracketOnError (Refresh.newRefresher local carrier options timing controls) Refresh.dispose $ \refresher -> do
            mapM_ (\owner -> Coupled.start owner (Browse.persistencePending browseQueries)
              ((||) <$> Browse.fetching browseQueries <*> Refresh.owes refresher)) (snd <$> ownedPersistence)
            pure (Client carrier contents typed local (newFrame typed timing) (newBind typed local timing) (newBeckon typed local)
              browseQueries gatherQueries matchQueries (Mark.newMark typed local timing follower)
              (Yield.newYield typed local contents timing follower) follower refresher (newJob typed local carrier options timing) (newAuth <$> gateway) (newSystem <$> gateway) (snd <$> ownedPersistence) disconnect)

fromHttp :: Http.HttpOptions -> Maybe CachePersistence -> IO Client
fromHttp options persistence = do
  ownedPersistence <- preparePersistence persistence
  let actual=case snd <$> ownedPersistence of
        Nothing -> options
        Just owner -> options { Http.httpLoadPositions=Coupled.loadPositions owner, Http.httpSavePosition=Coupled.savePosition owner }
  http <- Http.newHttpTransport actual `onException` mapM_ (Coupled.dispose . snd) ownedPersistence
  let time = Http.httpTime options
      busOptions = Bus.BusOptions (Retry.retryNow time) (Retry.retryWaitUntil time) (UUID.toText <$> Http.httpNewId options)
  construct (Http.transport http) (Http.content http) (Just (Http.gateway http)) busOptions (Http.httpTiming options) ownedPersistence
    `onException` (Http.dispose http `finally` mapM_ (Coupled.dispose . snd) ownedPersistence)

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

mark :: Client -> Mark.MarkNamespace
mark Client { clientMark = value } = value
yield :: Client -> Yield.YieldNamespace
yield Client { clientYield = value } = value

job :: Client -> JobNamespace
job Client { clientJob = value } = value
auth :: Client -> Maybe AuthNamespace
auth Client { clientAuth = value } = value
system :: Client -> Maybe SystemNamespace
system Client { clientSystem = value } = value

state :: Client -> StateValue Transport.ConnectionState
state = Transport.state . transport
-- | The places' gate is read first, before what it reads is disposed.
dispose :: Client -> IO ()
dispose client =
  mapM_ Coupled.dispose (clientCoupled client) `finally` Delegation.dispose (clientFollower client) `finally` Refresh.dispose (clientRefresh client) `finally` (Browse.dispose (browse client)
    `finally` Gather.dispose (gather client) `finally` Match.dispose (match client)
    `finally` Transport.dispose (transport client)) `finally` (Content.dispose (content client)
    `finally` (clientDisconnect client `finally` Local.closeEventBus (bus client)))
