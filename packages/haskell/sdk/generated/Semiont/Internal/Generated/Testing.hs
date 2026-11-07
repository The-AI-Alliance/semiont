-- Generated from Python testing/transport.py and testing/liveness.py; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.Testing where
import Data.Aeson (Object, Value)
import Data.Text (Text)
import Semiont.Retry (RetryOptions)
import Semiont.Transport (Transport, Carried)
import Test.QuickCheck (Gen, oneof, chooseInteger, chooseInt, vectorOf)
data FaultAction = Deliver | DropReply | Delay Integer | DuplicateReply | RejectEmit deriving (Eq, Show)
faultKind :: FaultAction -> Text
faultKind (Deliver) = "deliver"
faultKind (DropReply) = "drop-reply"
faultKind (Delay _) = "delay"
faultKind (DuplicateReply) = "duplicate-reply"
faultKind (RejectEmit) = "reject-emit"
data DeliveryOp = Write | Transition deriving (Eq, Ord, Show, Enum, Bounded)
deliveryOpName :: DeliveryOp -> Text
deliveryOpName Write = "write"
deliveryOpName Transition = "transition"
faultActions :: Gen FaultAction
faultActions = oneof [pure Deliver, pure DropReply, Delay <$> chooseInteger (0,5), pure DuplicateReply, pure RejectEmit]
faultSchedules :: Gen [FaultAction]
faultSchedules = chooseInt (1,8) >>= \count -> vectorOf count faultActions
slack :: Integer
slack = 4
type Respond = Text -> Object -> IO (Maybe Value)
data RequestLogEntry = RequestLogEntry
  { requestLogEntryChannel :: Text
  , requestLogEntryAction :: FaultAction
  , requestLogEntryCorrelationId :: Maybe Text
  , requestLogEntryRetryKey :: Text
  , requestLogEntryPayload :: Object
  }
-- The transport owner fills this with its real carrier and its native controls.
data FaultyTransport = FaultyTransport
  { carrier :: Transport
  , queueReply :: Text -> [Maybe Value] -> IO ()
  , refuseWhen :: (Text -> Object -> IO (Maybe Object)) -> IO ()
  , requestLog :: IO [RequestLogEntry]
  , deliver :: Carried -> IO ()
  }
data LivenessScenario = LivenessScenario
  { livenessScenarioOutputs :: [IO ()]
  , livenessScenarioSettlements :: [IO ()]
  }
data LivenessSpec = LivenessSpec
  { livenessSpecSetup :: FaultyTransport -> (LivenessScenario -> IO ()) -> IO ()
  , livenessSpecTimeoutMs :: Integer
  , livenessSpecRetryBudget :: Integer
  , livenessSpecCases :: Int
  , livenessSpecSchedules :: Gen [FaultAction]
  , livenessSpecMakeResponse :: Respond
  , livenessClock :: RetryOptions
  }
