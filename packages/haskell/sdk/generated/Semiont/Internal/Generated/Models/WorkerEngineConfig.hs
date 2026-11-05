-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.WorkerEngineConfig
  ( WorkerEngineConfig(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Engine
import Semiont.Internal.Generated.Models.JobFilter
data WorkerEngineConfig = WorkerEngineConfig { workerEngineConfigApiKeyEnv :: Maybe (Text), workerEngineConfigBaseUrl :: Text, workerEngineConfigEngine :: Engine, workerEngineConfigJobs :: [JobFilter] } deriving (Eq, Show)
instance FromJSON WorkerEngineConfig where
  parseJSON = checked "WorkerEngineConfig" $ withObject "WorkerEngineConfig" (\fields -> WorkerEngineConfig <$> optional fields "apiKeyEnv" <*> fields .: "baseUrl" <*> fields .: "engine" <*> fields .: "jobs")
instance ToJSON WorkerEngineConfig where toJSON value = Object (KM.fromList (concat [optionalPair "apiKeyEnv" (workerEngineConfigApiKeyEnv value), [("baseUrl", toJSON (workerEngineConfigBaseUrl value))], [("engine", toJSON (workerEngineConfigEngine value))], [("jobs", toJSON (workerEngineConfigJobs value))]]))

