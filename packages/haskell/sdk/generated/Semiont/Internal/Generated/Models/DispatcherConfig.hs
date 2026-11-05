-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.DispatcherConfig
  ( DispatcherConfig(..)
  , DispatcherConfigIdentity(..)
  , DispatcherConfigQueue(..)
  , DispatcherConfigTiming(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.KbIdentity
import Semiont.Internal.Generated.Models.LogFormat
import Semiont.Internal.Generated.Models.LogLevel
data DispatcherConfig = DispatcherConfig { dispatcherConfigGatewayUrl :: Text, dispatcherConfigIdentity :: DispatcherConfigIdentity, dispatcherConfigKb :: KbIdentity, dispatcherConfigLogFormat :: LogFormat, dispatcherConfigLogLevel :: LogLevel, dispatcherConfigPort :: Integer, dispatcherConfigQueue :: DispatcherConfigQueue, dispatcherConfigTiming :: DispatcherConfigTiming } deriving (Eq, Show)
instance FromJSON DispatcherConfig where
  parseJSON = checked "DispatcherConfig" $ withObject "DispatcherConfig" (\fields -> DispatcherConfig <$> fields .: "gatewayUrl" <*> fields .: "identity" <*> fields .: "kb" <*> fields .: "logFormat" <*> fields .: "logLevel" <*> fields .: "port" <*> fields .: "queue" <*> fields .: "timing")
instance ToJSON DispatcherConfig where toJSON value = Object (KM.fromList (concat [[("gatewayUrl", toJSON (dispatcherConfigGatewayUrl value))], [("identity", toJSON (dispatcherConfigIdentity value))], [("kb", toJSON (dispatcherConfigKb value))], [("logFormat", toJSON (dispatcherConfigLogFormat value))], [("logLevel", toJSON (dispatcherConfigLogLevel value))], [("port", toJSON (dispatcherConfigPort value))], [("queue", toJSON (dispatcherConfigQueue value))], [("timing", toJSON (dispatcherConfigTiming value))]]))

data DispatcherConfigIdentity = DispatcherConfigIdentity { dispatcherConfigIdentityIssuer :: Text } deriving (Eq, Show)
instance FromJSON DispatcherConfigIdentity where
  parseJSON = checked "DispatcherConfigIdentity" $ withObject "DispatcherConfigIdentity" (\fields -> DispatcherConfigIdentity <$> fields .: "issuer")
instance ToJSON DispatcherConfigIdentity where toJSON value = Object (KM.fromList (concat [[("issuer", toJSON (dispatcherConfigIdentityIssuer value))]]))

data DispatcherConfigQueue = DispatcherConfigQueue { dispatcherConfigQueuePasswordEnv :: Maybe (Text), dispatcherConfigQueueServers :: Text, dispatcherConfigQueueUserEnv :: Maybe (Text) } deriving (Eq, Show)
instance FromJSON DispatcherConfigQueue where
  parseJSON = checked "DispatcherConfigQueue" $ withObject "DispatcherConfigQueue" (\fields -> DispatcherConfigQueue <$> optional fields "passwordEnv" <*> fields .: "servers" <*> optional fields "userEnv")
instance ToJSON DispatcherConfigQueue where toJSON value = Object (KM.fromList (concat [optionalPair "passwordEnv" (dispatcherConfigQueuePasswordEnv value), [("servers", toJSON (dispatcherConfigQueueServers value))], optionalPair "userEnv" (dispatcherConfigQueueUserEnv value)]))

data DispatcherConfigTiming = DispatcherConfigTiming { dispatcherConfigTimingAckWaitMs :: Integer, dispatcherConfigTimingBootDeadlineMs :: Integer, dispatcherConfigTimingProgressWriteIntervalMs :: Integer, dispatcherConfigTimingRetentionMs :: Integer, dispatcherConfigTimingRetentionSweepMs :: Integer, dispatcherConfigTimingStaleRunningMs :: Integer, dispatcherConfigTimingTickMs :: Integer } deriving (Eq, Show)
instance FromJSON DispatcherConfigTiming where
  parseJSON = checked "DispatcherConfigTiming" $ withObject "DispatcherConfigTiming" (\fields -> DispatcherConfigTiming <$> fields .: "ackWaitMs" <*> fields .: "bootDeadlineMs" <*> fields .: "progressWriteIntervalMs" <*> fields .: "retentionMs" <*> fields .: "retentionSweepMs" <*> fields .: "staleRunningMs" <*> fields .: "tickMs")
instance ToJSON DispatcherConfigTiming where toJSON value = Object (KM.fromList (concat [[("ackWaitMs", toJSON (dispatcherConfigTimingAckWaitMs value))], [("bootDeadlineMs", toJSON (dispatcherConfigTimingBootDeadlineMs value))], [("progressWriteIntervalMs", toJSON (dispatcherConfigTimingProgressWriteIntervalMs value))], [("retentionMs", toJSON (dispatcherConfigTimingRetentionMs value))], [("retentionSweepMs", toJSON (dispatcherConfigTimingRetentionSweepMs value))], [("staleRunningMs", toJSON (dispatcherConfigTimingStaleRunningMs value))], [("tickMs", toJSON (dispatcherConfigTimingTickMs value))]]))

