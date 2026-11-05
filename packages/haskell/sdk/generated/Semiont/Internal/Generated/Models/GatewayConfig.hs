-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GatewayConfig
  ( GatewayConfig(..)
  , GatewayConfigArchivist(..)
  , GatewayConfigCapacity(..)
  , GatewayConfigIdentity(..)
  , GatewayConfigSignal(..)
  , GatewayConfigSignalType(..)
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
data GatewayConfig = GatewayConfig { gatewayConfigArchivist :: GatewayConfigArchivist, gatewayConfigCapacity :: GatewayConfigCapacity, gatewayConfigIdentity :: GatewayConfigIdentity, gatewayConfigKb :: KbIdentity, gatewayConfigLogFormat :: LogFormat, gatewayConfigLogLevel :: LogLevel, gatewayConfigPort :: Integer, gatewayConfigPublicUrl :: Text, gatewayConfigSignal :: GatewayConfigSignal } deriving (Eq, Show)
instance FromJSON GatewayConfig where
  parseJSON = checked "GatewayConfig" $ withObject "GatewayConfig" (\fields -> GatewayConfig <$> fields .: "archivist" <*> fields .: "capacity" <*> fields .: "identity" <*> fields .: "kb" <*> fields .: "logFormat" <*> fields .: "logLevel" <*> fields .: "port" <*> fields .: "publicUrl" <*> fields .: "signal")
instance ToJSON GatewayConfig where toJSON value = Object (KM.fromList (concat [[("archivist", toJSON (gatewayConfigArchivist value))], [("capacity", toJSON (gatewayConfigCapacity value))], [("identity", toJSON (gatewayConfigIdentity value))], [("kb", toJSON (gatewayConfigKb value))], [("logFormat", toJSON (gatewayConfigLogFormat value))], [("logLevel", toJSON (gatewayConfigLogLevel value))], [("port", toJSON (gatewayConfigPort value))], [("publicUrl", toJSON (gatewayConfigPublicUrl value))], [("signal", toJSON (gatewayConfigSignal value))]]))

data GatewayConfigArchivist = GatewayConfigArchivist { gatewayConfigArchivistHost :: Text, gatewayConfigArchivistPort :: Integer } deriving (Eq, Show)
instance FromJSON GatewayConfigArchivist where
  parseJSON = checked "GatewayConfigArchivist" $ withObject "GatewayConfigArchivist" (\fields -> GatewayConfigArchivist <$> fields .: "host" <*> fields .: "port")
instance ToJSON GatewayConfigArchivist where toJSON value = Object (KM.fromList (concat [[("host", toJSON (gatewayConfigArchivistHost value))], [("port", toJSON (gatewayConfigArchivistPort value))]]))

data GatewayConfigCapacity = GatewayConfigCapacity { gatewayConfigCapacityConnections :: Integer, gatewayConfigCapacityQueuedBytes :: Integer } deriving (Eq, Show)
instance FromJSON GatewayConfigCapacity where
  parseJSON = checked "GatewayConfigCapacity" $ withObject "GatewayConfigCapacity" (\fields -> GatewayConfigCapacity <$> fields .: "connections" <*> fields .: "queuedBytes")
instance ToJSON GatewayConfigCapacity where toJSON value = Object (KM.fromList (concat [[("connections", toJSON (gatewayConfigCapacityConnections value))], [("queuedBytes", toJSON (gatewayConfigCapacityQueuedBytes value))]]))

data GatewayConfigIdentity = GatewayConfigIdentity { gatewayConfigIdentityIssuer :: Text, gatewayConfigIdentitySubjectClaim :: Text } deriving (Eq, Show)
instance FromJSON GatewayConfigIdentity where
  parseJSON = checked "GatewayConfigIdentity" $ withObject "GatewayConfigIdentity" (\fields -> GatewayConfigIdentity <$> fields .: "issuer" <*> fields .: "subjectClaim")
instance ToJSON GatewayConfigIdentity where toJSON value = Object (KM.fromList (concat [[("issuer", toJSON (gatewayConfigIdentityIssuer value))], [("subjectClaim", toJSON (gatewayConfigIdentitySubjectClaim value))]]))

data GatewayConfigSignal = GatewayConfigSignal { gatewayConfigSignalPasswordEnv :: Maybe (Text), gatewayConfigSignalServers :: Maybe (Text), gatewayConfigSignalType :: GatewayConfigSignalType, gatewayConfigSignalUserEnv :: Maybe (Text) } deriving (Eq, Show)
instance FromJSON GatewayConfigSignal where
  parseJSON = checked "GatewayConfigSignal" $ withObject "GatewayConfigSignal" (\fields -> GatewayConfigSignal <$> optional fields "passwordEnv" <*> optional fields "servers" <*> fields .: "type" <*> optional fields "userEnv")
instance ToJSON GatewayConfigSignal where toJSON value = Object (KM.fromList (concat [optionalPair "passwordEnv" (gatewayConfigSignalPasswordEnv value), optionalPair "servers" (gatewayConfigSignalServers value), [("type", toJSON (gatewayConfigSignalType value))], optionalPair "userEnv" (gatewayConfigSignalUserEnv value)]))

data GatewayConfigSignalType = GatewayConfigSignalTypeInU2d_process | GatewayConfigSignalTypeNats deriving (Eq, Show)
instance FromJSON GatewayConfigSignalType where
  parseJSON = checked "GatewayConfigSignalType" $ \value -> if value == (String "in-process") then pure GatewayConfigSignalTypeInU2d_process else if value == (String "nats") then pure GatewayConfigSignalTypeNats else fail "unknown enumeration member"
instance ToJSON GatewayConfigSignalType where
  toJSON GatewayConfigSignalTypeInU2d_process = String "in-process"
  toJSON GatewayConfigSignalTypeNats = String "nats"


