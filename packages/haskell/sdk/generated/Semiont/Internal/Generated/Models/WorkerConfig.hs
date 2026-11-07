-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.WorkerConfig
  ( WorkerConfig(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.LogFormat
import Semiont.Internal.Generated.Models.LogLevel
import Semiont.Internal.Generated.Models.WorkerKnowledgeBaseConfig
data WorkerConfig = WorkerConfig { workerConfigKnowledgeBases :: [WorkerKnowledgeBaseConfig], workerConfigLogFormat :: LogFormat, workerConfigLogLevel :: LogLevel, workerConfigModelCatalogue :: Text, workerConfigPort :: Integer } deriving (Eq, Show)
instance FromJSON WorkerConfig where
  parseJSON = checked "WorkerConfig" $ withObject "WorkerConfig" (\fields -> WorkerConfig <$> fields .: "knowledgeBases" <*> fields .: "logFormat" <*> fields .: "logLevel" <*> fields .: "modelCatalogue" <*> fields .: "port")
instance ToJSON WorkerConfig where toJSON value = Object (KM.fromList (concat [[("knowledgeBases", toJSON (workerConfigKnowledgeBases value))], [("logFormat", toJSON (workerConfigLogFormat value))], [("logLevel", toJSON (workerConfigLogLevel value))], [("modelCatalogue", toJSON (workerConfigModelCatalogue value))], [("port", toJSON (workerConfigPort value))]]))
