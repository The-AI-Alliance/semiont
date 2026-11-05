-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.EmbeddingConfig
  ( EmbeddingConfig(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.OllamaEmbeddingConfig
import Semiont.Internal.Generated.Models.VoyageEmbeddingConfig
data EmbeddingConfig = EmbeddingConfigBranch1 (OllamaEmbeddingConfig) | EmbeddingConfigBranch2 (VoyageEmbeddingConfig) deriving (Eq, Show)
instance FromJSON EmbeddingConfig where
  parseJSON = checked "EmbeddingConfig" $ \value -> (EmbeddingConfigBranch1 <$> parseJSON value) <|> (EmbeddingConfigBranch2 <$> parseJSON value)
instance ToJSON EmbeddingConfig where
  toJSON (EmbeddingConfigBranch1 value) = toJSON value
  toJSON (EmbeddingConfigBranch2 value) = toJSON value


