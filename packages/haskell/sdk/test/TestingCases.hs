{-# LANGUAGE OverloadedStrings #-}
module TestingCases (testingCases) where

import Control.Concurrent.Async (async, cancel, wait, mapConcurrently_)
import Control.Concurrent.STM
import Control.Exception (SomeException, bracket, try, displayException)
import Control.Monad (forM_, unless, void)
import Data.Aeson (FromJSON, Value(..), toJSON, fromJSON, Result(..))
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Test.QuickCheck as QC
import qualified Test.QuickCheck.Random as QR
import qualified ControlledTime as Time
import SessionCases (jwt)
import qualified Semiont.Bus as Bus
import qualified Semiont.Channels as Channel
import qualified Semiont.Client as Client
import qualified Semiont.Content as Content
import qualified Semiont.Registry.Factory as Factory
import qualified Semiont.Registry.Stored as Stored
import qualified Semiont.Session as Session
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.State.SessionSignals as Signals
import qualified Semiont.StateValue as State
import Semiont.Retry (RetryOptions(..))
import qualified Semiont.Testing.Client as Testing
import qualified Semiont.Testing.Liveness as Live
import qualified Semiont.Testing.Sessions as Sessions
import qualified Semiont.Testing.Storage as Shared
import qualified Semiont.Testing.Transport as Faulty
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Types
import System.Timeout (timeout)

require :: String -> Bool -> IO ()
require label good=unless good (ioError (userError label))
fixture :: FromJSON result => Map.Map Text Value -> Text -> IO result
fixture fixtures name=case Map.lookup name fixtures of
  Just value -> case fromJSON value of Success parsed->pure parsed; Error diagnostic->ioError (userError diagnostic)
  Nothing -> ioError (userError "missing consumer-toolkit fixture")

clockOptions :: Time.ControlledTime -> IO (RetryOptions,Bus.BusOptions)
clockOptions time=do
  ids <- newTVarIO (0::Integer)
  pure (RetryOptions (Time.now time) (Time.waitUntil time) (pure 0),Bus.BusOptions (Time.now time) (Time.waitUntil time)
    (atomically (modifyTVar' ids (+1) >> Text.pack . show <$> readTVar ids)))

qc :: QC.Args
qc=QC.stdArgs {QC.maxSuccess=8,QC.chatty=False,QC.replay=Just (QR.mkQCGen 71,0)}

refuses :: String -> IO () -> IO ()
refuses word action=do
  result <- try action :: IO (Either SomeException ())
  require ("testing harness did not refuse a broken " ++ word ++ " subject") (case result of Left problem->Text.pack word `Text.isInfixOf` Text.pack (displayException problem); Right ()->False)

testingCases :: Map.Map Text Value -> IO ()
testingCases fixtures=do
  result <- timeout 20000000 $ do
    sharedCases
    livenessCases fixtures
    sessionCases fixtures
  require "consumer toolkit did not settle" (result==Just ())
  putStrLn "PASS consumer testing toolkit: controlled faults, L1/L2/L3 positive and negative subjects, shared contexts and real sessions"

sharedCases :: IO ()
sharedCases=do
  first <- Shared.newSharedStorage
  second <- Shared.context first
  notes <- newTVarIO []
  detach <- Storage.subscribe (Shared.storage first) (\key value->atomically (modifyTVar' notes (++[(key,value)])))
  Storage.set (Shared.storage first) "counter" "0"
  require "shared storage notified its own writer" . null =<< readTVarIO notes
  let increment _=Storage.update (Shared.storage second) "counter" $ \previous->case previous >>= readCount of
        Just value->(Just (Text.pack (show (value+1))),())
        Nothing->error "shared counter disappeared"
      readCount value=case reads (Text.unpack value) of [(count,"")]->Just (count::Integer); _->Nothing
  mapConcurrently_ increment [1..200::Int]
  require "shared storage lost an atomic update" . (==Just "200") =<< Storage.get (Shared.storage first) "counter"
  require "shared storage missed other contexts' writes" . (==200) . length =<< readTVarIO notes
  sequence_ detach
  Storage.delete (Shared.storage second) "counter"
  require "unsubscribed shared storage still delivered" . (==200) . length =<< readTVarIO notes

livenessCases :: Map.Map Text Value -> IO ()
livenessCases fixtures=do
  description <- fixture fixtures "KbDescription"
  let answer name _=if name=="browse:kb-requested" then pure (Just (toJSON (description::KbDescription))) else Faulty.refuseUnscriptedOperation name mempty
      subjects=[Faulty.Deliver,Faulty.DropReply,Faulty.Delay 2,Faulty.DuplicateReply,Faulty.RejectEmit]
      runLiveness schedule setup = do
        time <- Time.newTime
        (clock,busOptions) <- clockOptions time
        let spec=Live.LivenessSpec (setup busOptions) 10 0 1 (pure [schedule]) answer clock
        bracket (async (Live.assertLivenessAxioms qc spec)) cancel $ \running -> do
          Time.advance time 100000000
          wait running
      good busOptions over consume=bracket
        (async (void (Bus.request (Bus.newBus busOptions (Faulty.carrier over)) Channel.BrowseKbRequestedOperation (BrowseKbRequest mempty) 10))) cancel $ \request ->
          consume (Live.LivenessScenario [void (tryWait request)] [void (tryWait request)])
      tryWait request=try (wait request) :: IO (Either SomeException ())
  forM_ subjects (\schedule -> runLiveness schedule good)
  refuses "L1" (runLiveness Faulty.Deliver (\_ _ consume->consume (Live.LivenessScenario [atomically retry] [])))
  refuses "L2" (runLiveness Faulty.Deliver (\_ _ consume->consume (Live.LivenessScenario [] [atomically retry])))
  let subject multiply consume=do
        values <- newTVarIO []
        consume (Live.DeliverySubject (\identity->atomically (modifyTVar' values (++replicate multiply identity))) (pure ()) (readTVarIO values))
  Live.assertExactlyOnceDelivery qc (Live.deliveryOps 12) (subject 1)
  refuses "L3" (Live.assertExactlyOnceDelivery qc (pure [Live.Write,Live.Transition,Live.Write]) (subject 0))
  refuses "L3" (Live.assertExactlyOnceDelivery qc (pure [Live.Transition,Live.Write]) (subject 2))
  time <- Time.newTime
  (clock,busOptions) <- clockOptions time
  bracket (Faulty.newFaultyTransport clock [Faulty.DropReply,Faulty.Deliver] Faulty.refuseUnscriptedOperation (Set.fromList Channel.globalChannels))
    (Transport.dispose . Faulty.carrier) $ \over -> do
      Faulty.queueReply over "browse:kb-requested" [Just (toJSON (description::KbDescription)),Just (toJSON description {kbDescriptionName="next answer"})]
      let ask=Bus.request (Bus.newBus busOptions (Faulty.carrier over)) Channel.BrowseKbRequestedOperation (BrowseKbRequest mempty) 10
      bracket (async (void ask)) cancel $ \request -> do
        Time.advance time 10000000
        result <- tryWait request
        require "a dropped reply did not time out" (case result of Left _->True; Right ()->False)
      next <- ask
      require "lost reply did not consume its scripted answer" (kbDescriptionName (browseKbResultResponse next)=="next answer")
      require "fault schedule did not record both requests" . (==2) . length =<< Faulty.requestLog over

sessionCases :: Map.Map Text Value -> IO ()
sessionCases fixtures=do
  time <- Time.newTime
  (clock,busOptions) <- clockOptions time
  let contents _=pure (Content.ContentTransport (\_ _ _ _->unexpected) (\_ _->unexpected) (\_ _ _->unexpected)
        (\_ _->unexpected) (\_ _->unexpected) (\_ _->unexpected) (pure ()),Nothing)
      unexpected :: IO result
      unexpected=ioError (userError "unscripted content in consumer-session case")
  scripted <- Sessions.newScriptedSessions clock busOptions Timing.protocolSettings (pure 1800000000)
    (\_ name payload->Faulty.refuseUnscriptedOperation name payload) contents
  user <- fixture fixtures "UserResponse"
  originalGrant <- fixture fixtures "StoredSession"
  let grant=originalGrant {storedSessionAccess=jwt 3600 9}
  Sessions.saysWho scripted (Just user)
  store <- Storage.newMemoryStorage
  Stored.storeSession store "consumer-kb" grant
  let kb=KnowledgeBase "did:web:consumer.test" (KbEndpointBranch2 (LocalEndpoint "consumer-kb" LocalEndpointKindLocal mempty)) "consumer-kb" "Consumer" Nothing mempty
  bracket Signals.newSessionSignals Signals.dispose $ \signals -> do
    let inputs=Factory.SessionFactoryOptions kb store signals
    bracket (Factory.openSession (Sessions.factory scripted) inputs) Session.closeOpenedSession $ \opened -> do
      Session.ready (Session.openedSession opened)
      require "scripted factory did not build a real validating session" . (==Just user) =<< atomically (State.current (Session.user (Session.openedSession opened)))
      require "scripted factory did not retain its carrier" . (==1) . length =<< Sessions.transports scripted "consumer-kb"
      let options=Session.SessionOptions "borrowed" (Session.kb (Session.openedSession opened)) (Stored.keptIn store "none") Nothing Nothing Nothing
            (const (pure ())) (pure 1800000000)
      bracket (Testing.createTestSession (Testing.TestSessionOptions (Session.client (Session.openedSession opened)) options clock Timing.protocolSettings)) Testing.closeTestSession $ \made ->
        Session.ready (Testing.testSessionSession made)
      require "test session disposed its borrowed client" . (/=Transport.Closed) =<< atomically (State.current (Client.state (Session.client (Session.openedSession opened))))
    Factory.revokeSession (Sessions.factory scripted) grant
    require "scripted revocation was not recorded" . (==[grant]) =<< Sessions.revoked scripted
