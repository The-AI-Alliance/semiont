{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
-- | A host's knowledge-base registry. Activation owns a session and its client,
-- serializes their lifetimes, and projects tabs only for a live connection.
module Semiont.Registry
  ( SemiontBrowser, SemiontBrowserConfig(..), SessionFactory(..), SessionFactoryOptions(..), newHttpSessionFactory
  , SignedIn(..), Expected(..), SignInOutcome(..), KbReadVerdict(..), KbReadKind(..)
  , OpenResource(..), TabCheck(..), TabVerdict(..), applyTabChecks, sortOpenResources
  , newSemiontBrowser, kbs, activeKbId, activeSession, activeSignals, sessionActivating, openResources, lastViewedResource
  , identityToken, setIdentityToken, errors, storage, bus, dispose
  , addKb, removeKb, updateKb, setActiveKb, signIn, signedIn, signOut
  , addOpenResource, removeOpenResource, updateOpenResourceName, reorderOpenResources, setLastViewedResource, readActiveKb
  , beginSignIn, completeSignIn, KbSessionStatus(..), kbSessionStatus
  , module Semiont.Registry.Stored
  ) where

import Control.Concurrent (myThreadId)
import Control.Concurrent.Async (Async, asyncThreadId, wait, waitCatch, mapConcurrently)
import OpenTelemetry.Context.ThreadLocal.Propagation (tracedAsync)
import Control.Concurrent.QSem (newQSem, waitQSem, signalQSem)
import Control.Concurrent.MVar
import Control.Concurrent.STM
import Control.Exception (SomeException, SomeAsyncException, bracket, bracket_, finally, fromException, mask, onException, throwIO, try)
import Control.Monad (forM_, unless, void, when)
import Control.Monad.IO.Class (liftIO)
import Data.Aeson (FromJSON, ToJSON, Value(..), eitherDecodeStrict', encode, fromJSON, toJSON, Result(..))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString.Lazy as Lazy
import Data.List (find)
import qualified Data.Map.Strict as Map
import Data.Maybe (fromMaybe, isJust)
import Data.Scientific (Scientific)
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import Data.Time (formatTime, defaultTimeLocale)
import Data.Time.Clock.POSIX (posixSecondsToUTCTime)
import qualified Data.UUID.Types as UUID
import qualified Semiont.Browse as Browse
import qualified Semiont.Cache as Cache
import qualified Semiont.Client as Client
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (SessionError(..), TransportError(..), BusRequestError(..), SignInError)
import qualified Semiont.EventBus as Local
import qualified Semiont.Http as Http
import qualified Semiont.Identity as Identity
import qualified Semiont.Internal.Broadcast as Broadcast
import qualified Semiont.Internal.Lifetime as Lifetime
import qualified Semiont.Internal.Stored as Kept
import qualified Semiont.Timing as Timing
import qualified Semiont.Internal.Coupled as Coupled
import qualified Semiont.Internal.Generated.CachePersistence as Persistent
import qualified Semiont.Internal.Persistence as Persistence
import qualified Semiont.Tokens as Tokens
import qualified Semiont.Internal.StateValue as State
import qualified Semiont.Issuer as Issuer
import Semiont.Registry.Factory
import qualified Semiont.Registry.Identity as Connection
import Semiont.Registry.Resources
import Semiont.Registry.Stored
import qualified Semiont.Resources as Resources
import qualified Semiont.Session as Session
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.State.SessionSignals as Signals
import Semiont.Types
import Streaming (Of, Stream)
import qualified Streaming.Prelude as Stream

-- The factory owns the transport choice; this pool/clock are for a redirect
-- sign-in and its isolated identity proof, and never navigate the host.
data SemiontBrowserConfig = SemiontBrowserConfig
  { registryStorage :: Storage.SessionStorage
  , registryFactory :: SessionFactory
  , registryHttp :: Http.HttpOptions
  , registryWallNow :: IO Scientific
  }
data Live = Live Integer Session.OpenedSession Signals.SessionSignals (Async ())
data SemiontBrowser = SemiontBrowser
  { configuration :: SemiontBrowserConfig, lifetime :: Lifetime.Lifetime, activation :: MVar ()
  , revision :: TVar Integer, live :: TVar (Maybe Live), activations :: TVar Integer
  , registered :: State.StateValue [KnowledgeBase], selected :: State.StateValue (Maybe Text)
  , connected :: State.StateValue (Maybe Session.Session), notices :: State.StateValue (Maybe Signals.SessionSignals)
  , activating :: State.StateValue Bool, opened :: State.StateValue [OpenResource], viewed :: State.StateValue (Maybe ResourceId)
  , identity :: State.StateValue (Maybe Text), failures :: Broadcast.Broadcast SessionError
  , openByKb :: TVar (KM.KeyMap Value), viewedByKb :: TVar (KM.KeyMap Value)
  , detach :: TVar (IO ()), backgroundFailures :: TVar [SomeException]
  , registryBus :: Local.EventBus, retired :: TQueue Live, closing :: MVar (Maybe (Async ()))
  }

storage :: SemiontBrowser -> Storage.SessionStorage
storage=registryStorage . configuration
bus :: SemiontBrowser -> Local.EventBus
bus=registryBus

kbs :: SemiontBrowser -> State.StateValue [KnowledgeBase]
kbs=registered
activeKbId :: SemiontBrowser -> State.StateValue (Maybe Text)
activeKbId=selected
activeSession :: SemiontBrowser -> State.StateValue (Maybe Session.Session)
activeSession=connected
activeSignals :: SemiontBrowser -> State.StateValue (Maybe Signals.SessionSignals)
activeSignals=notices
sessionActivating :: SemiontBrowser -> State.StateValue Bool
sessionActivating=activating
openResources :: SemiontBrowser -> State.StateValue [OpenResource]
openResources=opened
lastViewedResource :: SemiontBrowser -> State.StateValue (Maybe ResourceId)
lastViewedResource=viewed
identityToken :: SemiontBrowser -> State.StateValue (Maybe Text)
identityToken=identity
setIdentityToken :: SemiontBrowser -> Maybe Text -> STM ()
setIdentityToken owner=State.update (identity owner)

errors :: SemiontBrowser -> (Stream (Of SessionError) IO () -> IO result) -> IO result
errors owner consume=Broadcast.withSubscription (failures owner) $ \reader ->
  let loop=do value<-liftIO (atomically (Broadcast.next reader)); case value of Nothing->pure (); Just next->Stream.yield next >> loop
  in consume loop

jsonText :: ToJSON value => value -> Text
jsonText=decodeUtf8 . Lazy.toStrict . encode
readJSON :: FromJSON value => Maybe Text -> Maybe value
readJSON=(>>= either (const Nothing) Just . eitherDecodeStrict' . encodeUtf8)
document :: Maybe Text -> Maybe (KM.KeyMap Value)
document Nothing=Just KM.empty
document raw=case readJSON raw of Just (Object values)->Just values; _->Nothing
readValue :: FromJSON value => Value -> Maybe value
readValue value=case fromJSON value of Error _->Nothing; Success parsed->Just parsed

newSemiontBrowser :: SemiontBrowserConfig -> IO SemiontBrowser
newSemiontBrowser config = mask $ \restore -> do
  let store=registryStorage config
  initial <- restore (loadKnowledgeBases store)
  rawSelected <- restore (Storage.get store activeKey)
  rawOpened <- restore (Storage.get store openResourcesByKbKey)
  rawViewed <- restore (Storage.get store lastViewedResourceByKbKey)
  let chosen=case rawSelected >>= \key -> knowledgeBaseId <$> find ((==key) . knowledgeBaseId) initial of
        Just key->Just key
        Nothing->case initial of first:_->Just (knowledgeBaseId first); []->Nothing
  life <- Lifetime.newLifetime "Registry is closed"
  turn <- newMVar ()
  applicationBus <- Local.newEventBus
  closer <- newMVar Nothing
  owner <- atomically $ SemiontBrowser config life turn <$> newTVar 0 <*> newTVar Nothing <*> newTVar 0
    <*> State.newStateValue initial <*> State.newStateValue chosen <*> State.newStateValue Nothing <*> State.newStateValue Nothing
    <*> State.newStateValue False <*> State.newStateValue [] <*> State.newStateValue Nothing <*> State.newStateValue Nothing
    <*> Broadcast.newEvents <*> newTVar (fromMaybe KM.empty (document rawOpened)) <*> newTVar (fromMaybe KM.empty (document rawViewed))
    <*> newTVar (pure ()) <*> newTVar [] <*> pure applicationBus <*> newTQueue <*> pure closer
  let initialize=do
        saveKnowledgeBases store initial
        maybe (Storage.delete store activeKey) (Storage.set store activeKey) chosen
        unsubscribe <- Storage.subscribe store (writtenElsewhere owner)
        atomically (writeTVar (detach owner) (fromMaybe (pure ()) unsubscribe))
        forM_ chosen (\key -> spawn owner (setActiveKb owner (Just key)))
        pure owner
  restore initialize `onException` dispose owner

spawn :: SemiontBrowser -> IO () -> IO ()
spawn owner action=void $ Lifetime.start (lifetime owner) $ action `catchSync` \problem -> atomically (modifyTVar' (backgroundFailures owner) (<>[problem]))
catchSync :: IO result -> (SomeException -> IO result) -> IO result
catchSync action recover=do
  result <- try action
  case result of
    Left problem | Just (_::SomeAsyncException)<-fromException problem -> throwIO problem
    Left problem -> recover problem
    Right value -> pure value

project :: SemiontBrowser -> STM ()
project owner=do
  current <- readTVar (live owner)
  case current of
    Nothing -> State.update (opened owner) [] >> State.update (viewed owner) Nothing
    Just (Live _ openedSession _ _) -> do
      let key=Key.fromText (Session.id (Session.openedSession openedSession))
      documents <- readTVar (openByKb owner)
      lastSeen <- readTVar (viewedByKb owner)
      State.update (opened owner) (sortOpenResources (fromMaybe [] (KM.lookup key documents >>= readValue)))
      State.update (viewed owner) (KM.lookup key lastSeen >>= readValue)

closeLive :: Live -> IO ()
closeLive (Live _ openedSession signals routing)=Session.closeOpenedSession openedSession `finally` (void (waitCatch routing) `finally` Signals.dispose signals)
takeLive :: SemiontBrowser -> STM (Maybe Live)
takeLive owner=do
  previous <- readTVar (live owner)
  writeTVar (live owner) Nothing
  State.update (connected owner) Nothing
  State.update (notices owner) Nothing
  project owner
  mapM_ (writeTQueue (retired owner)) previous
  pure previous

drainRetired :: SemiontBrowser -> IO ()
drainRetired owner=do
  previous <- atomically (flushTQueue (retired owner))
  foldr (\held rest -> closeLive held `finally` rest) (pure ()) previous

setActiveKb :: SemiontBrowser -> Maybe Text -> IO ()
setActiveKb owner requested=Lifetime.run (lifetime owner) $ mask $ \restore -> do
  selectedVersion <- atomically $ do
    existing <- readTVar (live owner)
    current <- State.current (selected owner)
    case existing of
      Just _ | current==requested -> pure Nothing
      _ -> do
        modifyTVar' (revision owner) (+1)
        version <- readTVar (revision owner)
        State.update (selected owner) requested
        void (takeLive owner)
        modifyTVar' (activations owner) (+1)
        State.update (activating owner) True
        pure (Just version)
  forM_ selectedVersion $ \version -> do
    let finish=atomically $ do
          modifyTVar' (activations owner) (subtract 1)
          readTVar (activations owner) >>= State.update (activating owner) . (>0)
        run=do
          maybe (Storage.delete (storage owner) activeKey) (Storage.set (storage owner) activeKey) requested
          withMVar (activation owner) $ \() -> do
            drainRetired owner
            current <- readTVarIO (revision owner)
            when (current==version) (forM_ requested (activate owner version))
    restore run `finally` finish

activate :: SemiontBrowser -> Integer -> Text -> IO ()
activate owner version key=do
  entries <- atomically (State.current (registered owner))
  forM_ (find ((==key) . knowledgeBaseId) entries) $ \entry ->
    bracket Signals.newSessionSignals (\signals -> do
      held <- readTVarIO (live owner)
      case held of Just (Live actual _ _ _) | actual==version -> pure (); _->Signals.dispose signals) $ \signals -> do
      let failed failure=atomically (Broadcast.publish (failures owner) failure)
          options=SessionFactoryOptions entry (storage owner) signals failed
      acquired <- try (openSession (registryFactory (configuration owner)) options)
      case acquired of
        Left (problem::SomeException) | Just (_::SomeAsyncException)<-fromException problem -> throwIO problem
        Left problem -> case fromException problem :: Maybe SessionError of
          Just failure -> failed failure
          Nothing | isJust (fromException problem :: Maybe TransportError)
            ||isJust (fromException problem :: Maybe BusRequestError)||isJust (fromException problem :: Maybe SignInError) ->
              failed (SessionError Code.SessionConstructFailed "Could not construct the knowledge base's session" key)
          Nothing -> throwIO problem
        Right openedSession -> do
          let session=Session.openedSession openedSession
              route (Left failure)=failed failure
              route (Right failure)=atomically $ do
                case transportErrorCode failure of
                  Code.TransportForbidden -> Signals.notifyPermissionDenied signals (Just (transportErrorMessage failure))
                  _ -> pure ()
          routing <- Lifetime.start (lifetime owner) (Session.errors session (Stream.mapM_ route))
            `onException` Session.closeOpenedSession openedSession
          let owned=Live version openedSession signals routing
          ready <- try (Session.ready session)
          case ready of
            Left (problem::SomeException) -> closeLive owned >> throwIO problem
            Right () -> do
              accepted <- atomically $ do
                current <- readTVar (revision owner)
                stopped <- Lifetime.isClosed (lifetime owner)
                if current/=version || stopped then pure False else do
                  writeTVar (live owner) (Just owned)
                  State.update (connected owner) (Just session)
                  State.update (notices owner) (Just signals)
                  project owner
                  pure True
              if accepted then spawn owner (validateOpened owner version session) else closeLive owned

writeKbs :: SemiontBrowser -> ([KnowledgeBase] -> [KnowledgeBase]) -> IO [KnowledgeBase]
writeKbs owner change=do
  values <- Storage.update (storage owner) knowledgeBasesKey $ \raw ->
    let before=case readJSON raw :: Maybe [Value] of
          Nothing -> []
          Just entries -> [value | entry<-entries,Just parsed<-[readValue entry],let value=Kept.projectKnowledgeBase parsed]
        next=map Kept.projectKnowledgeBase (change before)
    in (Just (jsonText next),next)
  atomically (State.update (registered owner) values)
  pure values

addKb :: SemiontBrowser -> NewKnowledgeBase -> StoredSession -> IO KnowledgeBase
addKb owner proposed grant=Lifetime.run (lifetime owner) $ do
  key <- UUID.toText <$> Http.httpNewId (registryHttp (configuration owner))
  let added=KnowledgeBase (newKnowledgeBaseDid proposed) (newKnowledgeBaseEndpoint proposed) key (newKnowledgeBaseLabel proposed)
        (newKnowledgeBaseLastRead proposed) mempty
  storeSession (storage owner) key grant
  void (writeKbs owner (<>[added]))
  setActiveKb owner (Just key)
  pure added

updateKb :: SemiontBrowser -> Text -> Maybe Text -> Maybe KbRead -> IO ()
updateKb owner key label reading=Lifetime.run (lifetime owner) $ void $ writeKbs owner $ map $ \entry ->
  if knowledgeBaseId entry/=key then entry else entry
    {knowledgeBaseLabel=fromMaybe (knowledgeBaseLabel entry) label,knowledgeBaseLastRead=case reading of Nothing->knowledgeBaseLastRead entry; Just value->Just value}

signIn :: SemiontBrowser -> Text -> StoredSession -> IO ()
signIn owner key grant=Lifetime.run (lifetime owner) $ do
  storeSession (storage owner) key grant
  atomically $ do
    current <- State.current (selected owner)
    when (current==Just key) (modifyTVar' (revision owner) (+1) >> void (takeLive owner))
  setActiveKb owner (Just key)

kbSessionStatus :: SemiontBrowser -> Text -> IO KbSessionStatus
kbSessionStatus owner key=do
  grant <- storedSession (storage owner) key
  now <- registryWallNow (configuration owner)
  pure $ case grant of
    Nothing -> KbSessionStatusSignedU2d_out
    Just held | Tokens.isTokenExpired (storedSessionAccess held) now -> KbSessionStatusExpired
              | otherwise -> KbSessionStatusAuthenticated

readNow :: SemiontBrowser -> KbDescription -> IO KbRead
readNow owner description=do
  now <- registryWallNow (configuration owner)
  pure (KbRead (Text.pack (formatTime defaultTimeLocale "%Y-%m-%dT%H:%M:%S%3QZ" (posixSecondsToUTCTime (realToFrac now)))) (kbDescriptionGitBranch description) mempty)

signedIn :: SemiontBrowser -> SignedIn -> IO SignInOutcome
signedIn owner completed=Lifetime.run (lifetime owner) $ do
  actual <- either (ioError . userError) (pure . userIdValue) (Identity.kbDid (kbDescriptionDomain (signedInDescription completed)))
  reading <- readNow owner (signedInDescription completed)
  entries <- atomically (State.current (registered owner))
  let atAddress=filter (\entry -> Connection.samePlace (knowledgeBaseEndpoint entry) (signedInEndpoint completed)) entries
      belief=case signedInKbId completed of
        Just key -> find ((==key) . knowledgeBaseId) entries
        Nothing -> case atAddress of [one]->Just one; _->Nothing
      expected=case signedInExpectedDid completed of
        Just did -> Just (Expected did (signedInExpectedName completed))
        Nothing -> (\entry -> Expected (knowledgeBaseDid entry) (Just (knowledgeBaseLabel entry))) <$> belief
  landed <- case find ((==actual) . knowledgeBaseDid) atAddress of
    Nothing -> addKb owner (NewKnowledgeBase actual (signedInEndpoint completed) (kbDescriptionName (signedInDescription completed)) (Just reading) mempty) (signedInSession completed)
    Just existing -> do
      updateKb owner (knowledgeBaseId existing) (Just (kbDescriptionName (signedInDescription completed))) (Just reading)
      signIn owner (knowledgeBaseId existing) (signedInSession completed)
      pure existing {knowledgeBaseLabel=kbDescriptionName (signedInDescription completed),knowledgeBaseLastRead=Just reading}
  pure (SignInOutcome expected landed)

signOut :: SemiontBrowser -> Text -> IO ()
signOut owner key=Lifetime.run (lifetime owner) $ do
  grant <- storedSession (storage owner) key
  clearStoredSession (storage owner) key
  forM_ grant (spawn owner . revokeSession (registryFactory (configuration owner)))
  atomically $ do
    current <- State.current (selected owner)
    State.current (registered owner) >>= State.update (registered owner)
    when (current==Just key) (modifyTVar' (revision owner) (+1) >> void (takeLive owner))
  withMVar (activation owner) (const (drainRetired owner))

changeDocument :: SemiontBrowser -> Text -> (KM.KeyMap Value -> KM.KeyMap Value) -> IO (KM.KeyMap Value)
changeDocument owner key transform=do
  result <- Storage.update (storage owner) key $ \raw -> case document raw of
    Nothing -> (raw,Left "The registry document is not an object; it was not changed")
    Just values -> let next=transform values in (Just (jsonText (Object next)),Right next)
  either (ioError . userError) pure result

removeKb :: SemiontBrowser -> Text -> IO ()
removeKb owner key=Lifetime.run (lifetime owner) $ do
  clearStoredSession (storage owner) key
  opens <- changeDocument owner openResourcesByKbKey (KM.delete (Key.fromText key))
  lastSeen <- changeDocument owner lastViewedResourceByKbKey (KM.delete (Key.fromText key))
  entries <- writeKbs owner (filter ((/=key) . knowledgeBaseId))
  atomically (writeTVar (openByKb owner) opens >> writeTVar (viewedByKb owner) lastSeen >> project owner)
  current <- atomically (State.current (selected owner))
  when (current==Just key) (setActiveKb owner (case entries of first:_->Just (knowledgeBaseId first); []->Nothing))
  -- Close its client before deleting documents: the final cache flush must
  -- not recreate data belonging to a registry entry that was removed.
  withMVar (activation owner) (const (drainRetired owner))
  forM_ [minBound..maxBound :: Persistent.KeptQuery] $ \query -> Storage.delete (storage owner) (Persistence.documentKey key query)
  Storage.delete (storage owner) (Coupled.placesKey key)

currentKey :: SemiontBrowser -> STM (Maybe Text)
currentKey owner=do current<-readTVar (live owner); pure (case current of Nothing->Nothing; Just (Live _ openedSession _ _)->Just (Session.id (Session.openedSession openedSession)))
changeOpen :: SemiontBrowser -> ([OpenResource] -> [OpenResource]) -> IO ()
changeOpen owner transform=do
  key <- atomically (currentKey owner)
  forM_ key (\identity -> changeOpenOf owner identity transform)
changeOpenOf :: SemiontBrowser -> Text -> ([OpenResource] -> [OpenResource]) -> IO ()
changeOpenOf owner identity transform=do
  changed <- changeDocument owner openResourcesByKbKey $ \values ->
    let before=fromMaybe [] (KM.lookup (Key.fromText identity) values >>= readValue)
    in KM.insert (Key.fromText identity) (toJSON (transform before)) values
  atomically (writeTVar (openByKb owner) changed >> project owner)

addOpenResource :: SemiontBrowser -> ResourceId -> Text -> Maybe Text -> Maybe Text -> IO ()
addOpenResource owner resource name media uri=Lifetime.run (lifetime owner) $ do
  now <- floor . (*1000) <$> registryWallNow (configuration owner)
  changeOpen owner $ \tabs -> case find ((==resource) . openResourceId) tabs of
    Just _ -> [if openResourceId tab/=resource then tab else tab {openResourceName=name
      ,openResourceMediaType=case media of Nothing->openResourceMediaType tab; Just value->Just value
      ,openResourceStorageUri=case uri of Nothing->openResourceStorageUri tab; Just value->Just value} | tab<-tabs]
    Nothing -> tabs++[OpenResource resource media name now (maximum (0:[1+openResourceOrder tab | tab<-tabs])) uri mempty]
removeOpenResource :: SemiontBrowser -> ResourceId -> IO ()
removeOpenResource owner resource=Lifetime.run (lifetime owner) (changeOpen owner (filter ((/=resource) . openResourceId)))
updateOpenResourceName :: SemiontBrowser -> ResourceId -> Text -> IO ()
updateOpenResourceName owner resource name=Lifetime.run (lifetime owner) (changeOpen owner (map (\tab->if openResourceId tab==resource then tab {openResourceName=name} else tab)))
reorderOpenResources :: SemiontBrowser -> Int -> Int -> IO ()
reorderOpenResources owner from to=Lifetime.run (lifetime owner) $ changeOpen owner $ \tabs ->
  if from<0 || to<0 || from>=length tabs || to>=length tabs then tabs else
    let sorted=sortOpenResources tabs
        moved=sorted!!from
        rest=take from sorted++drop (from+1) sorted
    in zipWith (\order tab->tab {openResourceOrder=order}) [0..] (take to rest++[moved]++drop to rest)
setLastViewedResource :: SemiontBrowser -> ResourceId -> IO ()
setLastViewedResource owner resource=Lifetime.run (lifetime owner) $ do
  key <- atomically (currentKey owner)
  forM_ key $ \identity -> do
    values <- changeDocument owner lastViewedResourceByKbKey (KM.insert (Key.fromText identity) (toJSON resource))
    atomically (writeTVar (viewedByKb owner) values >> project owner)

noVerdict :: KbReadVerdict
noVerdict=KbReadVerdictBranch3 (KbReadVerdictBranch3Value KbReadKindNoU2d_verdict)
readKb :: SemiontBrowser -> Session.Session -> Text -> IO KbReadVerdict
readKb owner session key=do
  entries <- atomically (State.current (registered owner))
  case find ((==key) . knowledgeBaseId) entries of
    Nothing -> pure noVerdict
    Just entry -> do
      readBack <- (do
        description <- Browse.kb (Client.browse (Session.client session))
        did <- either (ioError . userError) (pure . userIdValue) (Identity.kbDid (kbDescriptionDomain description))
        pure (Just (description,did))) `catchSync` const (pure Nothing)
      case readBack of
        Nothing -> pure noVerdict
        Just (description,did) ->
          if did/=knowledgeBaseDid entry then pure (KbReadVerdictBranch2 (KbReadVerdictBranch2Value KbReadKindConflict did (kbDescriptionName description))) else do
            reading <- readNow owner description
            updateKb owner key (Just (kbDescriptionName description)) (Just reading)
            pure (KbReadVerdictBranch1 (KbReadVerdictBranch1Value KbReadKindRecorded))

readActiveKb :: SemiontBrowser -> IO KbReadVerdict
readActiveKb owner=Lifetime.run (lifetime owner) $ do
  current <- readTVarIO (live owner)
  case current of Nothing->pure noVerdict; Just (Live _ openedSession _ _)->let session=Session.openedSession openedSession in readKb owner session (Session.id session)

validateOpened :: SemiontBrowser -> Integer -> Session.Session -> IO ()
validateOpened owner version session=do
  verdict <- readKb owner session (Session.id session)
  current <- readTVarIO (revision owner)
  when (current==version) $ case verdict of
    KbReadVerdictBranch2 conflict -> do
      changeOpenOf owner (Session.id session) (const [])
      values <- changeDocument owner lastViewedResourceByKbKey (KM.delete (Key.fromText (Session.id session)))
      entries <- atomically (State.current (registered owner))
      atomically $ do
        writeTVar (viewedByKb owner) values
        project owner
        active <- readTVar (live owner)
        forM_ (find ((==Session.id session) . knowledgeBaseId) entries) $ \entry -> case active of
          Just (Live actual _ signals _) | actual==version -> Signals.notifyKbIdentityConflict signals
            (Signals.KbIdentityConflict (knowledgeBaseDid entry) (kbReadVerdictBranch2ValueObservedDid conflict))
          _ -> pure ()
    _ -> do
      raw <- Storage.get (storage owner) openResourcesByKbKey
      let waiting=fromMaybe [] (document raw >>= KM.lookup (Key.fromText (Session.id session)) >>= readValue)
          checkTab tab = (do
            value <- Cache.fresh (Browse.resource (Client.browse (Session.client session)) (openResourceId tab))
            pure (openResourceId tab,TabCheckBranch2 (TabCheckBranch2Value (Resources.getPrimaryMediaType value) (resourceDescriptorName value) TabVerdictReady)))
            `catchSync` \problem -> pure (openResourceId tab,case fromException problem of
              Just failure | busRequestErrorCode failure==Code.BusRequestNotFound -> TabCheckBranch1 (TabCheckBranch1Value TabVerdictGone)
              _ -> TabCheckBranch3 (TabCheckBranch3Value TabVerdictUnknown))
      lanes <- newQSem (fromInteger Timing.checksAtOnceCount)
      checks <- Map.fromList <$> mapConcurrently (\tab -> bracket_ (waitQSem lanes) (signalQSem lanes) (checkTab tab)) waiting
      latest <- readTVarIO (revision owner)
      when (latest==version) (changeOpenOf owner (Session.id session) (`applyTabChecks` checks))

writtenElsewhere :: SemiontBrowser -> Text -> Maybe Text -> IO ()
writtenElsewhere owner key raw=do
  stopped <- atomically (Lifetime.isClosed (lifetime owner))
  unless stopped $ if key==openResourcesByKbKey || key==lastViewedResourceByKbKey then
    forM_ (document raw) $ \values -> atomically $ do
      writeTVar (if key==openResourcesByKbKey then openByKb owner else viewedByKb owner) values
      project owner
    else case kbOfSessionKey key of
      Just _ -> atomically (State.current (registered owner) >>= State.update (registered owner))
      Nothing -> pure ()

beginSignIn :: SemiontBrowser -> BeginAuthorizationOptions -> IO Text
beginSignIn owner options=Lifetime.run (lifetime owner) $ Issuer.beginAuthorization (issuer owner) options (storage owner)
issuer :: SemiontBrowser -> Issuer.IssuerOptions
issuer owner=let http=registryHttp (configuration owner) in Issuer.IssuerOptions (Http.httpClient http) (Http.httpTime http) (Http.httpTiming http)
completeSignIn :: SemiontBrowser -> Text -> IO SignInOutcome
completeSignIn owner callback=Lifetime.run (lifetime owner) $ do
  (pending,tokens) <- Issuer.completeAuthorization (issuer owner) callback (storage owner)
  identityProof <- Connection.describeConnection (registryHttp (configuration owner)) (pendingAuthorizationTarget pending) (issuedTokensAccess tokens)
  let endpoints=pendingAuthorizationIssuer pending
      grant=StoredSession (issuedTokensAccess tokens) Issuer.browserClientId Nothing (issuedTokensRefresh tokens) (issuerEndpointsRevocation endpoints) (issuerEndpointsToken endpoints) mempty
      completed=SignedIn (connectionIdentityDescription identityProof) (KbEndpointBranch1 (pendingAuthorizationTarget pending))
        (pendingAuthorizationExpectedDid pending) (pendingAuthorizationExpectedName pending) (pendingAuthorizationKbId pending) grant
  signedIn owner completed

dispose :: SemiontBrowser -> IO ()
dispose owner=mask $ \restore -> do
  closer <- modifyMVar (closing owner) $ \prior -> case prior of
    Just worker -> pure (prior,worker)
    Nothing -> do
      atomically (modifyTVar' (revision owner) (+1))
      worker <- tracedAsync $ do
        Lifetime.close (lifetime owner) `finally` do
          unsubscribe <- atomically $ do action<-readTVar (detach owner); writeTVar (detach owner) (pure ()); pure action
          unsubscribe `finally` do
            let closeConnections=withMVar (activation owner) $ \() -> do
                  atomically (void (takeLive owner))
                  drainRetired owner
                closeViews=atomically $ do
                  State.complete (registered owner); State.complete (selected owner); State.complete (connected owner); State.complete (notices owner)
                  State.complete (activating owner); State.complete (opened owner); State.complete (viewed owner); State.complete (identity owner)
                  Broadcast.close (failures owner)
            closeConnections `finally` (Local.closeEventBus (registryBus owner) `finally` closeViews)
        problems <- readTVarIO (backgroundFailures owner)
        case problems of first:_->throwIO first; []->pure ()
      pure (Just worker,worker)
  caller <- myThreadId
  unless (caller==asyncThreadId closer) (restore (wait closer))
