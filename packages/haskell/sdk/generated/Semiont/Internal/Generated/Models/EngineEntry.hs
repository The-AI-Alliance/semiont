-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.EngineEntry
  ( EngineEntry(..)
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
data EngineEntry = EngineEntry { engineEntryEngine :: Engine, engineEntryJobs :: Maybe ([JobFilter]) } deriving (Eq, Show)
instance FromJSON EngineEntry where
  parseJSON = checked "EngineEntry" $ withObject "EngineEntry" (\fields -> EngineEntry <$> fields .: "engine" <*> optional fields "jobs")
instance ToJSON EngineEntry where toJSON value = Object (KM.fromList (concat [[("engine", toJSON (engineEntryEngine value))], optionalPair "jobs" (engineEntryJobs value)]))

