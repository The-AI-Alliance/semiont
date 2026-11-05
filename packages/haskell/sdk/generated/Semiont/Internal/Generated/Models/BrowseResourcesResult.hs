-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseResourcesResult
  ( BrowseResourcesResult(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.ListResourcesResponse
data BrowseResourcesResult = BrowseResourcesResult { browseResourcesResultResponse :: ListResourcesResponse, browseResourcesResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseResourcesResult where
  parseJSON = checked "BrowseResourcesResult" $ withObject "BrowseResourcesResult" (\fields -> BrowseResourcesResult <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON BrowseResourcesResult where toJSON value = Object (KM.fromList (concat [[("response", toJSON (browseResourcesResultResponse value))]]) <> fmap toJSON (withoutFields ["response"] (browseResourcesResultAdditionalProperties value)))
