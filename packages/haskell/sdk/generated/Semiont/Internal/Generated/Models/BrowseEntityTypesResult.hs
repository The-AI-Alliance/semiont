-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseEntityTypesResult
  ( BrowseEntityTypesResult(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.GetEntityTypesResponse
data BrowseEntityTypesResult = BrowseEntityTypesResult { browseEntityTypesResultResponse :: GetEntityTypesResponse, browseEntityTypesResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseEntityTypesResult where
  parseJSON = checked "BrowseEntityTypesResult" $ withObject "BrowseEntityTypesResult" (\fields -> BrowseEntityTypesResult <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON BrowseEntityTypesResult where toJSON value = Object (KM.fromList (concat [[("response", toJSON (browseEntityTypesResultResponse value))]]) <> fmap toJSON (withoutFields ["response"] (browseEntityTypesResultAdditionalProperties value)))

