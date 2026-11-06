{-# LANGUAGE GADTs, OverloadedStrings #-}
module ActorCases (actorCases) where

import Control.Concurrent.STM
import Control.Exception (SomeException, bracket, fromException, throwIO, finally)
import Control.Monad (forM_, unless, when)
import Data.Aeson (FromJSON, ToJSON, Value(..), fromJSON, Result(..), eitherDecodeStrict', toJSON, object, (.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Foldable (toList)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as Text
import qualified ControlledTime as Time
import qualified Semiont.Bus as Bus
import qualified Semiont.Channels as Channel
import qualified Semiont.Client as Client
import qualified Semiont.Content as Content
import qualified Semiont.Delegation as Delegation
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (BusRequestError(..),TransportError(..))
import Semiont.Internal.Generated.Schemas (schemas)
import qualified Semiont.Internal.StateTasks as Tasks
import qualified Semiont.Internal.Transport as Local
import qualified Semiont.State.Beckon as Beckon
import qualified Semiont.State.Match as Match
import qualified Semiont.State.Gather as Gather
import qualified Semiont.State.Mark as Mark
import qualified Semiont.State.Yield as Yield
import qualified Semiont.StateValue as State
import Semiont.Retry (RetryOptions(..))
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Types
import qualified Streaming.Prelude as Stream
import System.FilePath ((</>))
import System.Timeout (timeout)

require :: String -> Bool -> IO ()
require label good=unless good (ioError (userError label))
member :: Text -> Value -> Value
member key (Object fields)=maybe (error ("missing actor case member " ++ Text.unpack key)) id (KM.lookup (Key.fromText key) fields)
member _ _=error "actor case member of nonobject"
array :: Value -> [Value]
array (Array values)=toList values
array _=error "actor case array expected"
decode :: FromJSON result => Value -> IO result
decode value=case fromJSON value of Error diagnostic->ioError (userError diagnostic); Success result->pure result
optional :: Text -> Value -> Maybe Value
optional key (Object fields)=KM.lookup (Key.fromText key) fields
optional _ _=Nothing
objectFields :: Value -> KM.KeyMap Value
objectFields (Object fields)=fields
objectFields _=error "actor case object expected"
text :: Value -> Text
text (String value)=value
text _=error "actor case string expected"

data Unit = Unit (Map.Map Text (STM Value)) (Map.Map Text (IO Bool)) (Text -> Value -> IO ()) (IO ())
property :: ToJSON value => Text -> State.StateValue value -> (Text,STM Value,IO Bool)
property name value=(name,toJSON <$> State.current value,State.watch value (fmap (const True) . Stream.toList_))
failedProperty :: Text -> State.StateValue (Maybe SomeException) -> (Text,STM Value,IO Bool)
failedProperty name value=(name,maybe Null errorValue <$> State.current value,State.watch value (fmap (const True) . Stream.toList_))
errorValue :: SomeException -> Value
errorValue problem
  | Just failed<-fromException problem :: Maybe BusRequestError = object ["code" .= Code.busRequestCode (busRequestErrorCode failed),"message" .= busRequestErrorMessage failed]
  | Just failed<-fromException problem :: Maybe TransportError = object ["code" .= Code.transportCode (transportErrorCode failed),"message" .= transportErrorMessage failed]
  | Just failed<-fromException problem :: Maybe Delegation.JobError = Object (KM.fromList
      ([ ("code",String (Code.jobCode (Delegation.jobErrorCode failed))) ] ++ maybe [] (\message -> [("message",String message)]) (Delegation.jobErrorMessage failed)))
  | otherwise=error "unexpected actor error type"
unitOf :: [(Text,STM Value,IO Bool)] -> (Text -> Value -> IO ()) -> IO () -> Unit
unitOf properties invoke close=Unit (Map.fromList [(name,value)|(name,value,_)<-properties]) (Map.fromList [(name,end)|(name,_,end)<-properties]) invoke close

makeUnit :: Client.Client -> Time.ControlledTime -> Text -> Value -> IO Unit
makeUnit client time kind inputs=case kind of
  "beckon" -> do
    unit <- decode (member "resourceId" inputs) >>= Beckon.newBeckonStateUnit client
    pure (unitOf [property "hoveredAnnotationId" (Beckon.hoveredAnnotationId unit)]
      (\name args -> case name of "focus"->decode (member "annotationId" args) >>= Beckon.focus unit; _->unknown) (Beckon.dispose unit))
  "match" -> do
    unit <- Match.newMatchStateUnit client
    pure (unitOf [] (\_ _->unknown) (Match.dispose unit))
  "gather" -> do
    unit <- decode (member "resourceId" inputs) >>= Gather.newGatherStateUnit client
    pure (unitOf [property "context" (Gather.context unit),property "loading" (Gather.loading unit),failedProperty "error" (Gather.error unit),property "annotationId" (Gather.annotationId unit)
      ,property "resourceContext" (Gather.resourceContext unit),property "resourceLoading" (Gather.resourceLoading unit),failedProperty "resourceError" (Gather.resourceError unit)]
      (\name args -> case name of
        "gatherAnnotation" -> do
          identity <- decode (member "annotationId" args)
          options <- decode (Object (KM.delete "annotationId" (objectFields args)))
          Gather.gatherAnnotation unit identity (Just options)
        "gatherResource" -> do
          identity <- decode (member "resourceId" args)
          options <- decode (Object (KM.delete "resourceId" (objectFields args)))
          Gather.gatherResource unit identity (Just options)
        _->unknown) (Gather.dispose unit))
  "yield" -> do
    unit <- decode (member "locale" inputs) >>= Yield.newYieldStateUnit client
    pure (unitOf [property "isGenerating" (Yield.isGenerating unit),property "progress" (Yield.progress unit),property "outcome" (Yield.outcome unit),failedProperty "failure" (Yield.failure unit),property "jobId" (Yield.jobId unit)]
      (\name args -> case name of
        "generate" -> do params<-decode (member "params" args); deadline<-traverse decode (optional "stallDeadlineMs" args); Yield.generate unit params deadline
        "dismissProgress"->atomically (Yield.dismissProgress unit)
        _->unknown) (Yield.dispose unit))
  "mark" -> do
    identity <- decode (member "resourceId" inputs)
    unit <- Mark.newMarkStateUnit client identity (RetryOptions (Time.now time) (Time.waitUntil time) (pure 0)) Timing.protocolSettings
    pure (unitOf [property "pendingAnnotation" (Mark.pendingAnnotation unit),property "delegatingMotivation" (Mark.delegatingMotivation unit),property "progress" (Mark.progress unit)
      ,property "progressMotivation" (Mark.progressMotivation unit),failedProperty "failure" (Mark.failure unit),property "jobId" (Mark.jobId unit)]
      (\name args -> case name of
        "requestDelegate"->decode (member "params" args) >>= Mark.requestDelegate unit
        "cancelPending"->atomically (Mark.cancelPending unit)
        "dismissProgress"->atomically (Mark.dismissProgress unit)
        _->unknown) (Mark.dispose unit))
  _->unknown
  where
    unknown :: IO result
    unknown=ioError (userError "unknown shared actor action or unit")

expand :: KM.KeyMap Value -> Value -> Value
expand fixtures value=case value of
  Object fields | Just (String name)<-KM.lookup "$fixture" fields -> maybe (error "unknown actor fixture") (expand fixtures) (KM.lookup (Key.fromText name) fixtures)
  Object fields -> Object (fmap (expand fixtures) fields)
  Array items -> Array (fmap (expand fixtures) items)
  _ -> value

matches :: Value -> Value -> Bool
matches (Object fields) actual | Just expected<-KM.lookup "$has" fields = subset expected actual
matches (Object expected) (Object actual)=KM.keys expected==KM.keys actual && all (\(key,value)->maybe False (matches value) (KM.lookup key actual)) (KM.toList expected)
matches (Array expected) (Array actual)=length expected==length actual && and (zipWith matches (toList expected) (toList actual))
matches expected actual=expected==actual
subset :: Value -> Value -> Bool
subset (Object expected) (Object actual)=all (\(key,value)->maybe False (matches value) (KM.lookup key actual)) (KM.toList expected)
subset expected actual=matches expected actual

data Rig = Rig Client.Client Transport.TransportInput (TVar [BusFrame]) (TVar (Map.Map Text [Value])) Tasks.Tasks
makeRig :: Time.ControlledTime -> Value -> IO Rig
makeRig time config=do
  sent <- newTVarIO []
  replies <- newTVarIO (Map.fromList [(Key.toText key,array values)|(key,values)<-KM.toList (maybe KM.empty objectFields (optional "replies" config))])
  tasks <- Tasks.newTasks "state-unit test transport is closed"
  inputCell <- newEmptyTMVarIO
  serial <- newTVarIO (0::Integer)
  let clock=Bus.BusOptions (Time.now time) (Time.waitUntil time) (atomically $ do modifyTVar' serial (+1); Text.pack . show <$> readTVar serial)
      content=Content.ContentTransport (\_ _ _ _->unexpected) (\_ _->unexpected) (\_ _ _->unexpected) (\_ _->unexpected) (\_ _->unexpected) (\_ _->unexpected) (pure ())
      send envelope=do
        atomically (modifyTVar' sent (++[envelope]))
        queued <- atomically $ do
          allReplies <- readTVar replies
          let channel=busFrameChannel envelope
          case Map.findWithDefault [] channel allReplies of
            []->pure Nothing
            first:rest->writeTVar replies (Map.insert channel rest allReplies) >> pure (Just first)
        let input=Object (busFramePayloadAdditionalProperties (busFramePayload envelope))
            channel=busFrameChannel envelope
            jobs=member "answers" config==String "jobs"
            auto
              | Just reply<-queued=Just reply
              | jobs && channel=="job:create"=Just (object ["jobId" .= ("job-1"::Text)])
              | jobs && channel=="job:status-requested"=Just (object ["jobId" .= member "jobId" input,"type" .= ("mark"::Text),"status" .= ("running"::Text),"userId" .= ("did:web:example.org:users:alice"::Text),"created" .= ("2026-10-01T00:00:00.000Z"::Text)])
              | otherwise=Nothing
        case auto of
          Nothing | member "answers" config==String "never" -> pure ()
          Nothing -> throwIO (BusRequestError Code.BusRequestRejected "scripted refusal" Nothing)
          Just reply -> Tasks.fork tasks $ do
            delay <- maybe (pure 0) decode (optional "delayMs" config)
            now <- Time.now time
            when (delay>0) (Time.waitUntil time (now+delay*1000000))
            inputPort <- atomically (readTMVar inputCell)
            deliverReply inputPort envelope reply
        pure (Just 1)
  (carrier,input) <- Transport.newTransport (Transport.TransportOptions "local://state-unit-cases" (Set.fromList Channel.channelNames) send (Tasks.dispose tasks))
  atomically (putTMVar inputCell input)
  Transport.setState input Transport.Connecting
  Transport.setState input Transport.Open
  client <- Client.newClient carrier content Nothing clock Timing.protocolSettings Nothing
  pure (Rig client input sent replies tasks)
  where
    unexpected :: IO result
    unexpected=ioError (userError "state-unit case unexpectedly used content transport")

-- The operation's generated success channel and schema determine wrapping.
deliverReply :: Transport.TransportInput -> BusFrame -> Value -> IO ()
deliverReply input request value=case [Channel.SomeOperation operation | Channel.SomeOperation operation<-Channel.allOperations,let (channel,_,_)=Channel.operationChannels operation,Channel.channelName channel==busFrameChannel request] of
  [Channel.SomeOperation operation] -> do
    let (_,reply,_)=Channel.operationChannels operation
        schema=Channel.channelSchema reply
        declared=maybe (error "no generated reply schema") id (Map.lookup schema schemas)
        properties=objectFields (member "properties" declared)
        wrapped=if KM.member "response" properties then Object (KM.singleton "response" value) else value
    Transport.receive input (BusFrame (Channel.channelName reply) (busFrameCorrelationId request) (BusFramePayload (objectFields wrapped)) Nothing)
  _->ioError (userError "state-unit reply has no generated operation")

actorCases :: FilePath -> IO ()
actorCases root=do
  table <- Bytes.readFile (root </> "protocol/specs/src/client/state-units.json") >>= either (ioError . userError) pure . eitherDecodeStrict'
  let fixtures=objectFields (member "fixtures" table)
      rows=[expand fixtures row|row<-array (member "cases" table),member "unit" row `elem` map String ["mark","yield","gather","match","beckon"]]
      duration (Number number)=toRational number
      duration value=let named=text (member "timing" value)
                         timing=member named (toJSON Timing.protocolSettings)
                     in duration timing * maybe 1 duration (optional "times" value) + maybe 0 duration (optional "plusMs" value)
  forM_ rows $ \row -> do
    result <- timeout 20000000 $ do
      time <- Time.newTime
      bracket (makeRig time (member "transport" row)) (\(Rig client _ _ _ _)->Client.dispose client) $ \(Rig client input sent queued tasks) -> do
        notes <- newTVarIO []
        settled <- newTVarIO False
        let channels=map text (maybe [] array (optional "listen" row))
        detach <- Local.tapLocal (Client.bus client) $ \carried _ -> case carried of
          Local.Arrived frame -> when (busFrameChannel (Local.wireFrame frame) `elem` channels)
            (modifyTVar' notes (++[Local.wireFrame frame]))
          Local.FrameRejected _ -> throwSTM (userError "valid actor signal was refused")
        units <- traverse (makeUnit client time (text (member "unit" row))) (objectFields (member "made" row))
        let lookupUnit name=maybe (ioError (userError "unknown named actor")) pure (KM.lookup (Key.fromText name) units)
            closeUnits=foldr finally detach [end|Unit _ _ _ end<-KM.elems units]
            requested channel nth=do
              frames <- filter ((==channel) . busFrameChannel) <$> readTVarIO sent
              case drop nth frames of first:_->pure first; []->ioError (userError ("unknown sent actor request " ++ Text.unpack channel))
            resolveCorrelation Nothing=pure Nothing
            resolveCorrelation (Just (String correlation))=pure (Just correlation)
            resolveCorrelation (Just value)=do
              channel<-decode (member "sent" value); nth<-decode (member "nth" value)
              busFrameCorrelationId <$> requested channel nth
            frameOf name step=do
              correlation<-resolveCorrelation (optional "correlationId" step)
              pure (BusFrame name correlation (BusFramePayload (objectFields (member "payload" step))) Nothing)
            run=forM_ (array (member "steps" row)) $ \step -> do
              case step of
                Object fields | any (`KM.member` fields) ["invoke","say","deliver","answer","queueReply","dispose"] -> atomically (writeTVar settled False)
                _ -> pure ()
              case step of
                String "settle"->Time.settle >> atomically (writeTVar settled True)
                Object fields | Just passed<-KM.lookup "pass" fields->Time.advance time (round (duration passed*1000000)) >> atomically (writeTVar settled True)
                Object fields | Just (String name)<-KM.lookup "invoke" fields->do
                  Unit _ _ invoke _<-lookupUnit (text (member "of" step)); invoke name (member "args" step)
                Object fields | Just (String channel)<-KM.lookup "say" fields->frameOf channel step >>= Local.local (Client.bus client) . (`Local.Frame` Nothing)
                Object fields | Just (String channel)<-KM.lookup "deliver" fields->frameOf channel step >>= Transport.receive input
                Object fields | Just (String channel)<-KM.lookup "answer" fields->do
                  nth<-decode (member "nth" step); original<-requested channel nth
                  payload<-decode (member "payload" step)
                  Transport.receive input (BusFrame (text (member "reply" step)) (busFrameCorrelationId original) payload Nothing)
                Object fields | Just (String channel)<-KM.lookup "queueReply" fields->atomically (modifyTVar' queued (Map.insertWith (flip (++)) channel [member "response" step]))
                Object fields | Just (String name)<-KM.lookup "dispose" fields->lookupUnit name >>= \(Unit _ _ _ end)->end
                Object fields | Just expected<-KM.lookup "expect" fields->forM_ (KM.toList (objectFields expected)) $ \(name,properties)->do
                  Unit values _ _ _<-lookupUnit (Key.toText name)
                  forM_ (KM.toList (objectFields properties)) $ \(key,value)->do
                    getter<-maybe (ioError (userError ("unknown actor observation " ++ show key))) pure (Map.lookup (Key.toText key) values)
                    actual<-atomically $ do
                      observed<-getter
                      afterSettle<-readTVar settled
                      let agrees=if Key.toText key `elem` ["error","resourceError","failure"] then subset value observed else matches value observed
                      when afterSettle (check agrees)
                      pure observed
                    let agrees=if Key.toText key `elem` ["error","resourceError","failure"] then subset value actual else matches value actual
                    require ("actor observation mismatch " ++ show (member "case" row) ++ " " ++ show key ++ ": " ++ show actual ++ " /= " ++ show value) agrees
                Object fields | Just ended<-KM.lookup "ended" fields->forM_ (KM.toList (objectFields ended)) $ \(name,properties)->do
                  Unit _ endings _ _<-lookupUnit (Key.toText name)
                  forM_ (array properties) $ \propertyName->do
                    end<-maybe (ioError (userError "unknown ended actor observation")) pure (Map.lookup (text propertyName) endings)
                    require "actor observation did not end" =<< end
                Object fields | Just (String channel)<-KM.lookup "sent" fields->do
                  frames<-filter ((==channel) . busFrameChannel) <$> readTVarIO sent
                  forM_ (optional "count" step) $ \count->require "actor sent count mismatch" (toJSON (length frames)==count)
                  forM_ (optional "payloads" step) $ \payloads->require ("actor sent payload mismatch " ++ show (member "case" row) ++ ": " ++ show frames) (matches payloads (toJSON (map (Object . busFramePayloadAdditionalProperties . busFramePayload) frames)))
                Object fields | Just (Bool True)<-KM.lookup "nothingSent" fields->require "actor unexpectedly sent a request" . null =<< readTVarIO sent
                Object fields | Just (Bool False)<-KM.lookup "busDestroyed" fields->do
                  probe<-newTVarIO False
                  detachProbe<-Local.tapLocal (Client.bus client) (\_ _->writeTVar probe True)
                  Local.local (Client.bus client) (Local.Frame (BusFrame "state-unit:test-probe" Nothing (BusFramePayload mempty) Nothing) Nothing)
                  require "actor destroyed its client's bus" =<< readTVarIO probe
                  detachProbe
                Object fields | Just expected<-KM.lookup "heard" fields->do
                  Time.settle
                  frames<-atomically (do values<-readTVar notes; writeTVar notes []; pure values)
                  let expectedFrame entry = do
                        correlation <- resolveCorrelation (optional "correlationId" entry)
                        pure (Object (KM.fromList
                          ([("channel",member "channel" entry),("payload",member "payload" entry)]
                          ++maybe [] (\value->[("correlationId",String value)]) correlation)))
                  expectedFrames <- traverse expectedFrame (array expected)
                  let actual=toJSON [Object (KM.fromList ([("channel",String (busFrameChannel frame)),("payload",Object (busFramePayloadAdditionalProperties (busFramePayload frame)))]++maybe [] (\value->[("correlationId",String value)]) (busFrameCorrelationId frame)))|frame<-frames]
                  require ("actor heard mismatch " ++ show (member "case" row) ++ ": " ++ show actual ++ " /= " ++ show expectedFrames) (matches (toJSON expectedFrames) actual)
                _->ioError (userError ("unimplemented actor case step " ++ show step))
        run `finally` (closeUnits `finally` Tasks.dispose tasks)
    require ("actor case did not settle: " ++ show (member "case" row)) (result==Just ())
  putStrLn "PASS every shared mark, yield, gather, match and beckon state-unit case"
