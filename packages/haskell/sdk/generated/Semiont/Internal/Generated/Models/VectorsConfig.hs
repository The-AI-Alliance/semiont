-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.VectorsConfig
  ( VectorsConfig(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.MemoryVectorsConfig
import Semiont.Internal.Generated.Models.QdrantVectorsConfig
data VectorsConfig = VectorsConfigBranch1 (QdrantVectorsConfig) | VectorsConfigBranch2 (MemoryVectorsConfig) deriving (Eq, Show)
instance FromJSON VectorsConfig where
  parseJSON = checked "VectorsConfig" $ \value -> (VectorsConfigBranch1 <$> parseJSON value) <|> (VectorsConfigBranch2 <$> parseJSON value)
instance ToJSON VectorsConfig where
  toJSON (VectorsConfigBranch1 value) = toJSON value
  toJSON (VectorsConfigBranch2 value) = toJSON value
