-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MemoryVectorsConfig
  ( MemoryVectorsConfig(..)
  , MemoryVectorsConfigType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data MemoryVectorsConfig = MemoryVectorsConfig { memoryVectorsConfigType :: MemoryVectorsConfigType } deriving (Eq, Show)
instance FromJSON MemoryVectorsConfig where
  parseJSON = checked "MemoryVectorsConfig" $ withObject "MemoryVectorsConfig" (\fields -> MemoryVectorsConfig <$> fields .: "type")
instance ToJSON MemoryVectorsConfig where toJSON value = Object (KM.fromList (concat [[("type", toJSON (memoryVectorsConfigType value))]]))

data MemoryVectorsConfigType = MemoryVectorsConfigTypeMemory deriving (Eq, Show)
instance FromJSON MemoryVectorsConfigType where
  parseJSON = checked "MemoryVectorsConfigType" $ \value -> if value == (String "memory") then pure MemoryVectorsConfigTypeMemory else fail "unknown enumeration member"
instance ToJSON MemoryVectorsConfigType where
  toJSON MemoryVectorsConfigTypeMemory = String "memory"


