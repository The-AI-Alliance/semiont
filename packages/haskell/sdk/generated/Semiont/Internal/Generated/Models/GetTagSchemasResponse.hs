-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GetTagSchemasResponse
  ( GetTagSchemasResponse(..)
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
data GetTagSchemasResponse = GetTagSchemasResponse { getTagSchemasResponseTagSchemas :: [TagSchema], getTagSchemasResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GetTagSchemasResponse where
  parseJSON = checked "GetTagSchemasResponse" $ withObject "GetTagSchemasResponse" (\fields -> GetTagSchemasResponse <$> fields .: "tagSchemas" <*> traverse parseJSON (withoutFields ["tagSchemas"] fields))
instance ToJSON GetTagSchemasResponse where toJSON value = Object (KM.fromList (concat [[("tagSchemas", toJSON (getTagSchemasResponseTagSchemas value))]]) <> fmap toJSON (withoutFields ["tagSchemas"] (getTagSchemasResponseAdditionalProperties value)))

