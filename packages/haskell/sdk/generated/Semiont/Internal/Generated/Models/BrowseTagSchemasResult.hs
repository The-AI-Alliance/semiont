-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseTagSchemasResult
  ( BrowseTagSchemasResult(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.GetTagSchemasResponse
data BrowseTagSchemasResult = BrowseTagSchemasResult { browseTagSchemasResultResponse :: GetTagSchemasResponse, browseTagSchemasResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseTagSchemasResult where
  parseJSON = checked "BrowseTagSchemasResult" $ withObject "BrowseTagSchemasResult" (\fields -> BrowseTagSchemasResult <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON BrowseTagSchemasResult where toJSON value = Object (KM.fromList (concat [[("response", toJSON (browseTagSchemasResultResponse value))]]) <> fmap toJSON (withoutFields ["response"] (browseTagSchemasResultAdditionalProperties value)))

