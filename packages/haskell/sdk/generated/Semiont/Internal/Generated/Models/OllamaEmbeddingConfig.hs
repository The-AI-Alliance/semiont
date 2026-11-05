-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.OllamaEmbeddingConfig
  ( OllamaEmbeddingConfig(..)
  , OllamaEmbeddingConfigType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data OllamaEmbeddingConfig = OllamaEmbeddingConfig { ollamaEmbeddingConfigBaseUrl :: Text, ollamaEmbeddingConfigModel :: Text, ollamaEmbeddingConfigType :: OllamaEmbeddingConfigType } deriving (Eq, Show)
instance FromJSON OllamaEmbeddingConfig where
  parseJSON = checked "OllamaEmbeddingConfig" $ withObject "OllamaEmbeddingConfig" (\fields -> OllamaEmbeddingConfig <$> fields .: "baseUrl" <*> fields .: "model" <*> fields .: "type")
instance ToJSON OllamaEmbeddingConfig where toJSON value = Object (KM.fromList (concat [[("baseUrl", toJSON (ollamaEmbeddingConfigBaseUrl value))], [("model", toJSON (ollamaEmbeddingConfigModel value))], [("type", toJSON (ollamaEmbeddingConfigType value))]]))

data OllamaEmbeddingConfigType = OllamaEmbeddingConfigTypeOllama deriving (Eq, Show)
instance FromJSON OllamaEmbeddingConfigType where
  parseJSON = checked "OllamaEmbeddingConfigType" $ \value -> if value == (String "ollama") then pure OllamaEmbeddingConfigTypeOllama else fail "unknown enumeration member"
instance ToJSON OllamaEmbeddingConfigType where
  toJSON OllamaEmbeddingConfigTypeOllama = String "ollama"


