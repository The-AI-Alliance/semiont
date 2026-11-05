-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GetEntityTypesResponse
  ( GetEntityTypesResponse(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data GetEntityTypesResponse = GetEntityTypesResponse { getEntityTypesResponseEntityTypes :: [Text], getEntityTypesResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GetEntityTypesResponse where
  parseJSON = checked "GetEntityTypesResponse" $ withObject "GetEntityTypesResponse" (\fields -> GetEntityTypesResponse <$> fields .: "entityTypes" <*> traverse parseJSON (withoutFields ["entityTypes"] fields))
instance ToJSON GetEntityTypesResponse where toJSON value = Object (KM.fromList (concat [[("entityTypes", toJSON (getEntityTypesResponseEntityTypes value))]]) <> fmap toJSON (withoutFields ["entityTypes"] (getEntityTypesResponseAdditionalProperties value)))
