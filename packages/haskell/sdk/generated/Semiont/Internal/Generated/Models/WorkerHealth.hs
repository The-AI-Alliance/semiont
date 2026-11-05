-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.WorkerHealth
  ( WorkerHealth(..)
  , WorkerHealthStatus(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.WorkerKnowledgeBaseHealth
data WorkerHealth = WorkerHealth { workerHealthKnowledgeBases :: [WorkerKnowledgeBaseHealth], workerHealthStatus :: WorkerHealthStatus } deriving (Eq, Show)
instance FromJSON WorkerHealth where
  parseJSON = checked "WorkerHealth" $ withObject "WorkerHealth" (\fields -> WorkerHealth <$> fields .: "knowledgeBases" <*> fields .: "status")
instance ToJSON WorkerHealth where toJSON value = Object (KM.fromList (concat [[("knowledgeBases", toJSON (workerHealthKnowledgeBases value))], [("status", toJSON (workerHealthStatus value))]]))

data WorkerHealthStatus = WorkerHealthStatusOk deriving (Eq, Show)
instance FromJSON WorkerHealthStatus where
  parseJSON = checked "WorkerHealthStatus" $ \value -> if value == (String "ok") then pure WorkerHealthStatusOk else fail "unknown enumeration member"
instance ToJSON WorkerHealthStatus where
  toJSON WorkerHealthStatusOk = String "ok"


