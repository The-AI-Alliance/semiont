-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GraphConfig
  ( GraphConfig(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.JanusGraphConfig
import Semiont.Internal.Generated.Models.MemoryGraphConfig
import Semiont.Internal.Generated.Models.Neo4jGraphConfig
import Semiont.Internal.Generated.Models.NeptuneGraphConfig
data GraphConfig = GraphConfigBranch1 (Neo4jGraphConfig) | GraphConfigBranch2 (JanusGraphConfig) | GraphConfigBranch3 (NeptuneGraphConfig) | GraphConfigBranch4 (MemoryGraphConfig) deriving (Eq, Show)
instance FromJSON GraphConfig where
  parseJSON = checked "GraphConfig" $ \value -> (GraphConfigBranch1 <$> parseJSON value) <|> (GraphConfigBranch2 <$> parseJSON value) <|> (GraphConfigBranch3 <$> parseJSON value) <|> (GraphConfigBranch4 <$> parseJSON value)
instance ToJSON GraphConfig where
  toJSON (GraphConfigBranch1 value) = toJSON value
  toJSON (GraphConfigBranch2 value) = toJSON value
  toJSON (GraphConfigBranch3 value) = toJSON value
  toJSON (GraphConfigBranch4 value) = toJSON value
