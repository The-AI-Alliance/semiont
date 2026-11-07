{-# LANGUAGE OverloadedStrings #-}
module StateUnitCases (stateUnitCases) where

import Control.Concurrent.STM
import Control.Exception (bracket)
import Control.Monad (forM_, unless)
import Data.Aeson (FromJSON, Value(..), fromJSON, Result(..), eitherDecodeStrict', toJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Foldable (toList)
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import qualified Semiont.State.SessionSignals as Signals
import qualified Semiont.StateValue as State
import qualified Streaming.Prelude as Stream
import System.FilePath ((</>))

require :: String -> Bool -> IO ()
require label good=unless good (ioError (userError label))
member :: Text -> Value -> Value
member key (Object fields)=maybe (error "missing state-unit case member") id (KM.lookup (Key.fromText key) fields)
member _ _=error "state-unit value is no object"
array :: Value -> [Value]
array (Array values)=toList values
array _=error "state-unit cases are no array"
decode :: FromJSON result => Value -> IO result
decode value=case fromJSON value of Error diagnostic->ioError (userError diagnostic); Success result->pure result

stateUnitCases :: FilePath -> IO ()
stateUnitCases root = do
  table <- Bytes.readFile (root </> "protocol/specs/src/client/state-units.json") >>= either (ioError . userError) pure . eitherDecodeStrict'
  let supported=map String ["mark","yield","gather","match","beckon","hoverDwell","search","sessionSignals"]
  require "shared state-unit table added a unit with no native behavior runner" (all (\row -> member "unit" row `elem` supported) (array (member "cases" table)))
  require "shared state-unit table lost a native behavior family" (all (\name -> any ((==name) . member "unit") (array (member "cases" table))) supported)
  let cases=[row | row<-array (member "cases" table),member "unit" row==String "sessionSignals"]
  require "the shared state-unit table lost session notices" (not (null cases))
  forM_ cases $ \row -> bracket Signals.newSessionSignals Signals.dispose $ \signals -> do
    let values=Map.fromList
          [("sessionEnded",toJSON <$> State.current (Signals.sessionEnded signals))
          ,("permissionDenied",toJSON <$> State.current (Signals.permissionDenied signals))
          ,("kbIdentityConflict",toJSON <$> State.current (Signals.kbIdentityConflict signals))]
        ended :: Map.Map Text (IO Bool)
        ended=Map.fromList
          [("sessionEnded",State.watch (Signals.sessionEnded signals) (fmap (const True) . Stream.toList_))
          ,("permissionDenied",State.watch (Signals.permissionDenied signals) (fmap (const True) . Stream.toList_))
          ,("kbIdentityConflict",State.watch (Signals.kbIdentityConflict signals) (fmap (const True) . Stream.toList_))]
        invoke name args=case name of
          "notifySessionEnded" -> decode (member "reason" args) >>= atomically . Signals.notifySessionEnded signals
          "notifyPermissionDenied" -> decode (member "detail" args) >>= atomically . Signals.notifyPermissionDenied signals
          "notifyKbIdentityConflict" -> decode (member "conflict" args) >>= atomically . Signals.notifyKbIdentityConflict signals
          "acknowledgeSessionEnded" -> atomically (Signals.acknowledgeSessionEnded signals)
          "acknowledgePermissionDenied" -> atomically (Signals.acknowledgePermissionDenied signals)
          "acknowledgeKbIdentityConflict" -> atomically (Signals.acknowledgeKbIdentityConflict signals)
          _ -> ioError (userError "unimplemented shared notice action")
    forM_ (array (member "steps" row)) $ \step -> case step of
      Object fields | Just (String name)<-KM.lookup "invoke" fields -> invoke name (member "args" step)
      Object fields | Just (Object expected)<-KM.lookup "expect" fields -> case KM.lookup "unit" expected of
        Just (Object properties) -> forM_ (KM.toList properties) $ \(key,value) -> do
          readValue <- maybe (ioError (userError "notice case asks for an unknown observation")) pure (Map.lookup (Key.toText key) values)
          actual <- atomically readValue
          require "session notice differs from the shared state-unit case" (actual==value)
        _ -> ioError (userError "notice expectation names no unit")
      Object fields | Just (String "unit")<-KM.lookup "dispose" fields -> Signals.dispose signals
      Object fields | Just (Object names)<-KM.lookup "ended" fields -> forM_ (array (member "unit" (Object names))) $ \name -> do
        key <- decode name
        readEnded <- maybe (ioError (userError "unknown ended notice")) pure (Map.lookup key ended)
        require "disposed session-notice observation did not end" =<< readEnded
      _ -> ioError (userError "unimplemented shared notice step")
  putStrLn "PASS every shared sessionSignals state-unit case"
