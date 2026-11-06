{-# LANGUAGE OverloadedStrings #-}
module FlowCases (flowCases) where

import Control.Concurrent.STM
import Control.Exception (bracket)
import Control.Monad (forM_, unless)
import Data.Aeson (FromJSON, Value(..), eitherDecodeStrict', fromJSON, Result(..), toJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Foldable (toList)
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import qualified Data.Text as Text
import qualified ControlledTime as Time
import Semiont.Retry (RetryOptions(..))
import qualified Semiont.State.HoverDwell as Hover
import qualified Semiont.State.Search as Search
import qualified Semiont.StateValue as State
import qualified Semiont.Timing.Settings as Timing
import qualified Streaming.Prelude as Stream
import System.FilePath ((</>))
import System.Timeout (timeout)

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))
member :: Text -> Value -> Value
member key (Object fields) = maybe (error ("missing flow case member " ++ Text.unpack key)) id (KM.lookup (Key.fromText key) fields)
member _ _ = error "flow case member of nonobject"
array :: Value -> [Value]
array (Array values) = toList values
array _ = error "flow case array expected"
decode :: FromJSON result => Value -> IO result
decode value = case fromJSON value of Error diagnostic -> ioError (userError diagnostic); Success result -> pure result
optional :: Text -> Value -> Maybe Value
optional name (Object fields) = KM.lookup (Key.fromText name) fields
optional _ _ = Nothing

data Subject = Subject
  { invoke :: Text -> Value -> IO ()
  , observations :: Map.Map Text (STM Value)
  , endings :: Map.Map Text (IO Bool)
  , heard :: IO Value
  , searched :: IO Value
  , answer :: Int -> Value -> IO ()
  , close :: IO ()
  }

flowCases :: FilePath -> IO ()
flowCases root = do
  table <- Bytes.readFile (root </> "protocol/specs/src/client/state-units.json") >>= either (ioError . userError) pure . eitherDecodeStrict'
  let rows = [row | row <- array (member "cases" table), member "unit" row `elem` [String "hoverDwell",String "search"]]
      duration (Number number) = toRational number
      duration value = let key=member "timing" value
                           timing=case key of String name -> member name (toJSON Timing.protocolSettings); _ -> error "invalid flow timing"
                           scale=maybe 1 duration (optional "times" value)
                           offset=maybe 0 duration (optional "plusMs" value)
                       in duration timing * scale + offset
  require "shared flow cases are absent" (not (null rows))
  forM_ rows $ \row -> do
    outcome <- timeout 10000000 $ do
      time <- Time.newTime
      let clock=RetryOptions (Time.now time) (Time.waitUntil time) (pure 0)
          inputs=member "unit" (member "made" row)
          made = case member "unit" row of
            String "hoverDwell" -> do
              notes <- newTVarIO []
              unit <- Hover.newHoverDwell clock (round (duration (member "delayMs" inputs))) $ \identity ->
                atomically (modifyTVar' notes (++[toJSON identity]))
              pure Subject
                { invoke= \name args -> case name of
                    "enter" -> decode (member "annotationId" args) >>= Hover.enter unit
                    "leave" -> Hover.leave unit
                    _ -> ioError (userError "unknown hover action")
                , observations=Map.empty, endings=Map.empty
                , heard=atomically $ do
                    items <- readTVar notes
                    writeTVar notes []
                    pure (toJSON [KM.fromList [("channel",String "beckon:hover"),("payload",Object (KM.singleton "annotationId" item))] | item<-items])
                , searched=pure (toJSON ([]::[Text])), answer= \_ _ -> ioError (userError "hover has no search")
                , close=Hover.dispose unit
                }
            String "search" -> do
              queries <- newTVarIO []
              streams <- newTVarIO []
              let source text publish = do
                    queue <- newTQueueIO
                    atomically $ do modifyTVar' queries (++[text]); modifyTVar' streams (++[queue])
                    let next = atomically (readTQueue queue) >>= publish >> next
                    next
                  debounce=maybe (fromInteger (Timing.searchDebounceMs Timing.protocolSettings)) duration (optional "debounceMs" inputs)
              initial <- maybe (pure "") decode (optional "initialQuery" inputs)
              unit <- Search.newSearchPipeline clock (round debounce) initial source
              pure Subject
                { invoke= \name args -> case name of
                    "setQuery" -> decode (member "value" args) >>= Search.setQuery unit
                    _ -> ioError (userError "unknown search action")
                , observations=Map.fromList [("query",toJSON <$> State.current (Search.query unit)),("state",toJSON <$> State.current (Search.state unit))]
                , endings=Map.fromList [("query",State.watch (Search.query unit) (fmap (const True) . Stream.toList_)),("state",State.watch (Search.state unit) (fmap (const True) . Stream.toList_))]
                , heard=pure (toJSON ([]::[Value])), searched=toJSON <$> readTVarIO queries
                , answer= \index value -> do
                    decoded <- decode value :: IO (Maybe [Text])
                    queues <- readTVarIO streams
                    case drop index queues of queue:_ -> atomically (writeTQueue queue decoded); [] -> ioError (userError "unknown shared search")
                , close=Search.dispose unit
                }
            _ -> ioError (userError "unknown flow subject")
      bracket made close $ \subject -> do
        Time.settle
        forM_ (array (member "steps" row)) $ \step -> do
          case step of
            String "settle" -> pure ()
            Object fields | Just (String name)<-KM.lookup "invoke" fields -> invoke subject name (member "args" step)
            Object fields | Just passed<-KM.lookup "pass" fields -> Time.advance time (round (duration passed * 1000000))
            Object fields | Just expected<-KM.lookup "heard" fields -> require "hover signal differs from shared case" . (==expected) =<< heard subject
            Object fields | Just expected<-KM.lookup "searched" fields -> require "search queries differ from shared case" . (==expected) =<< searched subject
            Object fields | Just index<-KM.lookup "answerSearch" fields -> decode index >>= \at -> answer subject at (member "results" step)
            Object fields | Just (String "unit")<-KM.lookup "dispose" fields -> close subject
            Object fields | Just expected<-KM.lookup "ended" fields -> forM_ (array (member "unit" expected)) $ \name -> do
              key <- decode name
              ended <- maybe (ioError (userError "unknown ended flow observation")) pure (Map.lookup key (endings subject))
              require "flow observation did not end" =<< ended
            Object fields | Just expected<-KM.lookup "expect" fields -> case member "unit" expected of
              Object properties -> forM_ (KM.toList properties) $ \(key,value) -> do
                getter <- maybe (ioError (userError "unknown flow observation")) pure (Map.lookup (Key.toText key) (observations subject))
                require ("flow observation differs: " ++ show row ++ " at " ++ show key) . (==value) =<< atomically getter
              _ -> ioError (userError "flow expectation is no object")
            _ -> ioError (userError "unknown shared flow step")
          Time.settle
    require ("flow case did not settle: " ++ show row) (outcome==Just ())
  putStrLn "PASS every shared hoverDwell and search state-unit case on the controlled clock"
