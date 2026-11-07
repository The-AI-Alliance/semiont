-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseAnnotationResult
  ( BrowseAnnotationResult(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.GetAnnotationResponse
data BrowseAnnotationResult = BrowseAnnotationResult { browseAnnotationResultResponse :: GetAnnotationResponse, browseAnnotationResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseAnnotationResult where
  parseJSON = checked "BrowseAnnotationResult" $ withObject "BrowseAnnotationResult" (\fields -> BrowseAnnotationResult <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON BrowseAnnotationResult where toJSON value = Object (KM.fromList (concat [[("response", toJSON (browseAnnotationResultResponse value))]]) <> fmap toJSON (withoutFields ["response"] (browseAnnotationResultAdditionalProperties value)))
