-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MemoryGraphConfig
  ( MemoryGraphConfig(..)
  , MemoryGraphConfigType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data MemoryGraphConfig = MemoryGraphConfig { memoryGraphConfigType :: MemoryGraphConfigType } deriving (Eq, Show)
instance FromJSON MemoryGraphConfig where
  parseJSON = checked "MemoryGraphConfig" $ withObject "MemoryGraphConfig" (\fields -> MemoryGraphConfig <$> fields .: "type")
instance ToJSON MemoryGraphConfig where toJSON value = Object (KM.fromList (concat [[("type", toJSON (memoryGraphConfigType value))]]))

data MemoryGraphConfigType = MemoryGraphConfigTypeMemory deriving (Eq, Show)
instance FromJSON MemoryGraphConfigType where
  parseJSON = checked "MemoryGraphConfigType" $ \value -> if value == (String "memory") then pure MemoryGraphConfigTypeMemory else fail "unknown enumeration member"
instance ToJSON MemoryGraphConfigType where
  toJSON MemoryGraphConfigTypeMemory = String "memory"


