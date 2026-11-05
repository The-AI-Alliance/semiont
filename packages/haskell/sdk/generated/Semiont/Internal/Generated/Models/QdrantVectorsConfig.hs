-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.QdrantVectorsConfig
  ( QdrantVectorsConfig(..)
  , QdrantVectorsConfigType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data QdrantVectorsConfig = QdrantVectorsConfig { qdrantVectorsConfigHost :: Text, qdrantVectorsConfigPort :: Integer, qdrantVectorsConfigTokenEnv :: Text, qdrantVectorsConfigType :: QdrantVectorsConfigType } deriving (Eq, Show)
instance FromJSON QdrantVectorsConfig where
  parseJSON = checked "QdrantVectorsConfig" $ withObject "QdrantVectorsConfig" (\fields -> QdrantVectorsConfig <$> fields .: "host" <*> fields .: "port" <*> fields .: "tokenEnv" <*> fields .: "type")
instance ToJSON QdrantVectorsConfig where toJSON value = Object (KM.fromList (concat [[("host", toJSON (qdrantVectorsConfigHost value))], [("port", toJSON (qdrantVectorsConfigPort value))], [("tokenEnv", toJSON (qdrantVectorsConfigTokenEnv value))], [("type", toJSON (qdrantVectorsConfigType value))]]))

data QdrantVectorsConfigType = QdrantVectorsConfigTypeQdrant deriving (Eq, Show)
instance FromJSON QdrantVectorsConfigType where
  parseJSON = checked "QdrantVectorsConfigType" $ \value -> if value == (String "qdrant") then pure QdrantVectorsConfigTypeQdrant else fail "unknown enumeration member"
instance ToJSON QdrantVectorsConfigType where
  toJSON QdrantVectorsConfigTypeQdrant = String "qdrant"
