-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.WorkerKnowledgeBaseConfig
  ( WorkerKnowledgeBaseConfig(..)
  , WorkerKnowledgeBaseConfigIdentity(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.WorkerEngineConfig
data WorkerKnowledgeBaseConfig = WorkerKnowledgeBaseConfig { workerKnowledgeBaseConfigDomain :: Text, workerKnowledgeBaseConfigEngines :: [WorkerEngineConfig], workerKnowledgeBaseConfigGatewayUrl :: Text, workerKnowledgeBaseConfigIdentity :: WorkerKnowledgeBaseConfigIdentity } deriving (Eq, Show)
instance FromJSON WorkerKnowledgeBaseConfig where
  parseJSON = checked "WorkerKnowledgeBaseConfig" $ withObject "WorkerKnowledgeBaseConfig" (\fields -> WorkerKnowledgeBaseConfig <$> fields .: "domain" <*> fields .: "engines" <*> fields .: "gatewayUrl" <*> fields .: "identity")
instance ToJSON WorkerKnowledgeBaseConfig where toJSON value = Object (KM.fromList (concat [[("domain", toJSON (workerKnowledgeBaseConfigDomain value))], [("engines", toJSON (workerKnowledgeBaseConfigEngines value))], [("gatewayUrl", toJSON (workerKnowledgeBaseConfigGatewayUrl value))], [("identity", toJSON (workerKnowledgeBaseConfigIdentity value))]]))

data WorkerKnowledgeBaseConfigIdentity = WorkerKnowledgeBaseConfigIdentity { workerKnowledgeBaseConfigIdentityClientId :: Text, workerKnowledgeBaseConfigIdentityIssuer :: Text } deriving (Eq, Show)
instance FromJSON WorkerKnowledgeBaseConfigIdentity where
  parseJSON = checked "WorkerKnowledgeBaseConfigIdentity" $ withObject "WorkerKnowledgeBaseConfigIdentity" (\fields -> WorkerKnowledgeBaseConfigIdentity <$> fields .: "clientId" <*> fields .: "issuer")
instance ToJSON WorkerKnowledgeBaseConfigIdentity where toJSON value = Object (KM.fromList (concat [[("clientId", toJSON (workerKnowledgeBaseConfigIdentityClientId value))], [("issuer", toJSON (workerKnowledgeBaseConfigIdentityIssuer value))]]))

