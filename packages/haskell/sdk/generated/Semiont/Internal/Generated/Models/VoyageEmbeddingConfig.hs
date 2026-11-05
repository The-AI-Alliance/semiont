-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.VoyageEmbeddingConfig
  ( VoyageEmbeddingConfig(..)
  , VoyageEmbeddingConfigType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data VoyageEmbeddingConfig = VoyageEmbeddingConfig { voyageEmbeddingConfigApiKeyEnv :: Text, voyageEmbeddingConfigEndpoint :: Text, voyageEmbeddingConfigModel :: Text, voyageEmbeddingConfigType :: VoyageEmbeddingConfigType } deriving (Eq, Show)
instance FromJSON VoyageEmbeddingConfig where
  parseJSON = checked "VoyageEmbeddingConfig" $ withObject "VoyageEmbeddingConfig" (\fields -> VoyageEmbeddingConfig <$> fields .: "apiKeyEnv" <*> fields .: "endpoint" <*> fields .: "model" <*> fields .: "type")
instance ToJSON VoyageEmbeddingConfig where toJSON value = Object (KM.fromList (concat [[("apiKeyEnv", toJSON (voyageEmbeddingConfigApiKeyEnv value))], [("endpoint", toJSON (voyageEmbeddingConfigEndpoint value))], [("model", toJSON (voyageEmbeddingConfigModel value))], [("type", toJSON (voyageEmbeddingConfigType value))]]))

data VoyageEmbeddingConfigType = VoyageEmbeddingConfigTypeVoyage deriving (Eq, Show)
instance FromJSON VoyageEmbeddingConfigType where
  parseJSON = checked "VoyageEmbeddingConfigType" $ \value -> if value == (String "voyage") then pure VoyageEmbeddingConfigTypeVoyage else fail "unknown enumeration member"
instance ToJSON VoyageEmbeddingConfigType where
  toJSON VoyageEmbeddingConfigTypeVoyage = String "voyage"


