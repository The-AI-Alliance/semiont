-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.WorkerKnowledgeBaseHealth
  ( WorkerKnowledgeBaseHealth(..)
  , WorkerKnowledgeBaseHealthState(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.WorkerEngineHealth
data WorkerKnowledgeBaseHealth = WorkerKnowledgeBaseHealth { workerKnowledgeBaseHealthDid :: Maybe (Text), workerKnowledgeBaseHealthDomain :: Text, workerKnowledgeBaseHealthEngines :: Maybe ([WorkerEngineHealth]), workerKnowledgeBaseHealthState :: WorkerKnowledgeBaseHealthState } deriving (Eq, Show)
instance FromJSON WorkerKnowledgeBaseHealth where
  parseJSON = checked "WorkerKnowledgeBaseHealth" $ withObject "WorkerKnowledgeBaseHealth" (\fields -> WorkerKnowledgeBaseHealth <$> optional fields "did" <*> fields .: "domain" <*> optional fields "engines" <*> fields .: "state")
instance ToJSON WorkerKnowledgeBaseHealth where toJSON value = Object (KM.fromList (concat [optionalPair "did" (workerKnowledgeBaseHealthDid value), [("domain", toJSON (workerKnowledgeBaseHealthDomain value))], optionalPair "engines" (workerKnowledgeBaseHealthEngines value), [("state", toJSON (workerKnowledgeBaseHealthState value))]]))

data WorkerKnowledgeBaseHealthState = WorkerKnowledgeBaseHealthStateStarting | WorkerKnowledgeBaseHealthStateWorking | WorkerKnowledgeBaseHealthStateRefused deriving (Eq, Show)
instance FromJSON WorkerKnowledgeBaseHealthState where
  parseJSON = checked "WorkerKnowledgeBaseHealthState" $ \value -> if value == (String "starting") then pure WorkerKnowledgeBaseHealthStateStarting else if value == (String "working") then pure WorkerKnowledgeBaseHealthStateWorking else if value == (String "refused") then pure WorkerKnowledgeBaseHealthStateRefused else fail "unknown enumeration member"
instance ToJSON WorkerKnowledgeBaseHealthState where
  toJSON WorkerKnowledgeBaseHealthStateStarting = String "starting"
  toJSON WorkerKnowledgeBaseHealthStateWorking = String "working"
  toJSON WorkerKnowledgeBaseHealthStateRefused = String "refused"
