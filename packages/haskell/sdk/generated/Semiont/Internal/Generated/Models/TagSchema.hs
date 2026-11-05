-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.TagSchema
  ( TagSchema(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.TagCategory
data TagSchema = TagSchema { tagSchemaDescription :: Text, tagSchemaDomain :: Text, tagSchemaId :: Text, tagSchemaName :: Text, tagSchemaTags :: [TagCategory], tagSchemaAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON TagSchema where
  parseJSON = checked "TagSchema" $ withObject "TagSchema" (\fields -> TagSchema <$> fields .: "description" <*> fields .: "domain" <*> fields .: "id" <*> fields .: "name" <*> fields .: "tags" <*> traverse parseJSON (withoutFields ["description", "domain", "id", "name", "tags"] fields))
instance ToJSON TagSchema where toJSON value = Object (KM.fromList (concat [[("description", toJSON (tagSchemaDescription value))], [("domain", toJSON (tagSchemaDomain value))], [("id", toJSON (tagSchemaId value))], [("name", toJSON (tagSchemaName value))], [("tags", toJSON (tagSchemaTags value))]]) <> fmap toJSON (withoutFields ["description", "domain", "id", "name", "tags"] (tagSchemaAdditionalProperties value)))

