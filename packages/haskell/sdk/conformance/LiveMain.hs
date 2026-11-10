{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
-- The parity driver uses only public SDK modules. Its query vocabulary is
-- generated from the contract, so a new query needs a native implementation.
module Main (main) where

import Control.Concurrent.Async
import Control.Concurrent.MVar
import Control.Concurrent.STM
import Control.Exception
import Control.Monad (unless, void, when)
import Data.Aeson hiding (decode)
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString.Char8 as Char8
import qualified Data.ByteString.Lazy as Lazy
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.UUID.V4 as UUID
import Data.Time.Clock.POSIX (getPOSIXTime)
import DriverProtocol
import LiveQueries
import Network.HTTP.Client (defaultManagerSettings, noProxy)
import qualified Semiont.Browse as Browse
import qualified Semiont.Cache as Cache
import qualified Semiont.Channels as Channels
import qualified Semiont.Client as Client
import qualified Semiont.Delegation as Delegation
import qualified Semiont.Gather as Gather
import qualified Semiont.Http as Http
import qualified Semiont.Mark as Mark
import qualified Semiont.Match as Match
import qualified Semiont.Retry as Retry
import qualified Semiont.Running as Running
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.StateValue as State
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Transport.Facts (connectionStateName)
import qualified Semiont.Yield as Yield
import qualified Streaming.Prelude as Stream
import System.IO
import System.Random (randomRIO)

data Driver = Driver
  { current :: TVar (Maybe Client.Client), closed :: TVar Bool
  , observers :: TVar (Map.Map Text (Async ())), workers :: TVar [Async ()]
  , output :: MVar (), fatal :: TMVar SomeException
  , httpPool :: Http.HttpClient, storage :: Storage.SessionStorage
  , reported :: TVar (Maybe Text)
  }

-- A line is written whole or not at all: a thread cancelled between a line's text and its newline would leave the
-- next line on the same one.
say :: Driver -> Value -> IO ()
say driver value=withMVar (output driver) (\()->uninterruptibleMask_ (Lazy.hPut stdout (encode value<>"\n") >> hFlush stdout))
opened :: Driver -> IO Client.Client
opened driver=readTVarIO (current driver) >>= maybe (throwIO (Misuse "no client is open")) pure
stateJSON :: Cache.CacheState Value -> IO Value
stateJSON Cache.Pending=pure (object ["status" .= ("pending"::Text)])
stateJSON (Cache.Ready value)=pure (object ["status" .= ("ready"::Text),"value" .= value])
stateJSON (Cache.Failed problem)=case failure problem of
  Just reason->pure (object ["status" .= ("failed"::Text),"error" .= reason])
  Nothing->throwIO problem

queryOf :: Client.Client -> Object -> IO (Cache.Query Value)
queryOf client args=do
  named <- need args "query"
  let resource=need args "resource"
      filters=maybe KM.empty id <$> optional args "filters"
  case named of
    Resource->fmap toJSON . Browse.resource (Client.browse client) <$> resource
    Annotations->fmap toJSON . Browse.annotations (Client.browse client) <$> resource
    Annotation->do identity<-resource; mark<-need args "annotation"; pure (toJSON <$> Browse.annotation (Client.browse client) identity mark)
    Events->fmap toJSON . Browse.events (Client.browse client) <$> resource
    ReferencedBy->fmap toJSON . Gather.referencedBy (Client.gather client) <$> resource
    Resources->do chosen<-filters >>= decode . Object; pure (toJSON <$> Browse.resources (Client.browse client) (Just chosen))
    MatchedResources->do wanted<-need args "search"; chosen<-filters >>= decode . Object; pure (toJSON <$> Match.resources (Client.match client) wanted (Just chosen))
    EntityTypes->pure (toJSON <$> Browse.entityTypes (Client.browse client))
    TagSchemas->pure (toJSON <$> Browse.tagSchemas (Client.browse client))
    Engines->pure (toJSON <$> Browse.engines (Client.browse client))

emitState :: Driver -> Text -> Cache.CacheState Value -> IO ()
emitState driver observer state=stateJSON state >>= \value -> say driver (object ["emission" .= object ["observer" .= observer,"state" .= value]])

launch :: Driver -> IO () -> IO (Async ())
launch driver action=mask $ \restore -> do
  worker <- async (restore action `catch` \(problem::SomeException)->case fromException problem::Maybe SomeAsyncException of
    Just _->throwIO problem
    Nothing->atomically (void (tryPutTMVar (fatal driver) problem)))
  atomically (modifyTVar' (workers driver) (worker:))
  pure worker

open :: Driver -> Object -> IO Value
open driver args=do
  prior <- readTVarIO (current driver)
  wasClosed <- readTVarIO (closed driver)
  when (maybe False (const True) prior && not wasClosed) (throwIO (Misuse "a client is already open"))
  address <- need args "baseUrl"
  token <- need args "token"
  overrides <- maybe (Object KM.empty) id <$> optional args "timing"
  timing <- either (throwIO . Misuse) pure (Timing.withOverrides overrides)
  persisted <- maybe False id <$> optional args "persist"
  let options=Http.HttpOptions address (httpPool driver) (pure (Just token)) (const (pure Nothing))
        (Retry.RetryOptions now waitUntil (randomRIO (0,1))) timing UUID.nextRandom
        (Set.fromList Channels.globalChannels) (pure Map.empty) (\_ _->pure ())
      persistence=if persisted then Just (Client.CachePersistence (storage driver) "conformance" "conformance" (realToFrac . (*1000) <$> getPOSIXTime)) else Nothing
  client <- Client.fromHttp options persistence
  atomically $ do writeTVar (current driver) (Just client); writeTVar (closed driver) False; writeTVar (observers driver) Map.empty; writeTVar (reported driver) Nothing
  void $ launch driver $ State.watch (Client.state client) (Stream.mapM_ $ \state -> do
    let name=connectionStateName state
    changed <- atomically $ do before<-readTVar (reported driver); writeTVar (reported driver) (Just name); pure (before/=Just name)
    when changed (say driver (object ["state" .= name])))
  void $ launch driver $ Transport.errors (Client.transport client) (Stream.mapM_ $ \problem ->
    case failure (toException problem) of
      Just reason -> say driver (object ["error" .= reason])
      Nothing -> throwIO problem)
  pure Null

observe :: Driver -> Object -> IO Value
observe driver args=do
  client <- opened driver
  name <- free driver args
  query <- need args "query" >>= queryOf client
  ready <- newEmptyTMVarIO
  worker <- launch driver $ Cache.watch query $ \states -> do
    first <- Stream.next states
    case first of
      Left ()->say driver (object ["completed" .= name]) >> atomically (putTMVar ready ())
      Right (value,rest)->do
        emitState driver name value
        atomically (putTMVar ready ())
        Stream.mapM_ (emitState driver name) rest
        say driver (object ["completed" .= name])
  atomically (modifyTVar' (observers driver) (Map.insert name worker))
  outcome <- race (atomically (readTMVar ready)) (wait worker)
  case outcome of Left ()->pure Null; Right ()->pure Null

free :: Driver -> Object -> IO Text
free driver args=do
  name <- need args "observer"
  active <- readTVarIO (observers driver)
  when (Map.member name active) (throwIO (Misuse "observer is already in use"))
  pure name

follow :: ToJSON completion => Driver -> Text -> Running.Running (Delegation.JobEvent completion) completion -> IO Value
follow driver name run=do
  worker <- launch driver $ do
    let work=Running.withReports run (void . Stream.mapM_ (emitState driver name . Cache.Ready . toJSON))
    work `catch` \(problem::SomeException)->case failure problem of
      Just _->emitState driver name (Cache.Failed problem)
      Nothing->throwIO problem
    say driver (object ["completed" .= name])
  atomically (modifyTVar' (observers driver) (Map.insert name worker))
  pure Null

perform :: Driver -> Text -> Object -> Maybe (IO Value)
perform driver operation args=case operation of
  "open"->Just (open driver args)
  "close"->Just $ do client<-opened driver; Client.dispose client; atomically (writeTVar (closed driver) True); pure Null
  "observe"->Just (observe driver args)
  "unobserve"->Just $ do
    name<-need args "observer"
    worker<-atomically $ do active<-readTVar (observers driver); writeTVar (observers driver) (Map.delete name active); pure (Map.lookup name active)
    maybe (throwIO (Misuse "observer was not registered")) cancel worker
    pure Null
  "fresh"->Just $ do client<-opened driver; query<-need args "query" >>= queryOf client; value<-Cache.fresh query; pure (object ["value" .= value])
  "invalidate"->Just $ do client<-opened driver; query<-need args "query" >>= queryOf client; Cache.invalidateQuery query; pure Null
  "markDelegate"->Just $ do
    client<-opened driver; name<-free driver args; resource<-need args "resource"; params<-need args "params"
    Mark.delegate (Client.mark client) resource params >>= follow driver name
  "yieldDelegate"->Just $ do
    client<-opened driver; name<-free driver args; params<-need args "params"; deadline<-need args "stallDeadlineMs"
    Yield.delegate (Client.yield client) params (Just deadline) >>= follow driver name
  "delete"->Just $ do client<-opened driver; resource<-need args "resource"; mark<-need args "annotation"; void (Mark.delete (Client.mark client) resource mark); pure Null
  "sync"->Just (pure Null)
  _->Nothing

answer :: Driver -> Integer -> IO Value -> IO ()
answer driver identifier action=do
  outcome <- try action
  either throwIO (say driver) (answerValue identifier outcome)

serve :: Driver -> IO ()
serve driver=do
  say driver (object ["ready" .= True])
  let loop=do
        ended<-hIsEOF stdin
        unless ended $ do
          line<-Char8.hGetLine stdin
          args<-either (throwIO . Misuse) decode (eitherDecodeStrict' line)
          identifier<-need args "id"
          operation<-need args "op"
          case perform driver operation args of
            Nothing->say driver (object ["id" .= (identifier::Integer),"unsupported" .= True])
            Just action | operation `elem` ["fresh","delete"]->void (launch driver (answer driver identifier action))
            Just action->answer driver identifier action
          loop
  loop

main :: IO ()
main=do
  hSetBuffering stdout NoBuffering
  pool <- Http.newHttpClient noProxy defaultManagerSettings
  store <- Storage.newMemoryStorage
  driver <- Driver <$> newTVarIO Nothing <*> newTVarIO False <*> newTVarIO Map.empty <*> newTVarIO [] <*> newMVar () <*> newEmptyTMVarIO <*> pure pool <*> pure store <*> newTVarIO Nothing
  let close=do
        readTVarIO (current driver) >>= mapM_ Client.dispose
        readTVarIO (workers driver) >>= mapM_ cancel
  void (race (serve driver) (atomically (readTMVar (fatal driver)) >>= throwIO)) `finally` close
