-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.TagSchemasProjection
  ( TagSchemasProjection(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.TagSchema
data TagSchemasProjection = TagSchemasProjection { tagSchemasProjectionTagSchemas :: [TagSchema] } deriving (Eq, Show)
instance FromJSON TagSchemasProjection where
  parseJSON = checked "TagSchemasProjection" $ withObject "TagSchemasProjection" (\fields -> TagSchemasProjection <$> fields .: "tagSchemas")
instance ToJSON TagSchemasProjection where toJSON value = Object (KM.fromList (concat [[("tagSchemas", toJSON (tagSchemasProjectionTagSchemas value))]]))
