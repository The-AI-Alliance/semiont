-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseEnginesResult
  ( BrowseEnginesResult(..)
  , BrowseEnginesResultResponse(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.EngineEntry
data BrowseEnginesResult = BrowseEnginesResult { browseEnginesResultResponse :: BrowseEnginesResultResponse, browseEnginesResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseEnginesResult where
  parseJSON = checked "BrowseEnginesResult" $ withObject "BrowseEnginesResult" (\fields -> BrowseEnginesResult <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON BrowseEnginesResult where toJSON value = Object (KM.fromList (concat [[("response", toJSON (browseEnginesResultResponse value))]]) <> fmap toJSON (withoutFields ["response"] (browseEnginesResultAdditionalProperties value)))

data BrowseEnginesResultResponse = BrowseEnginesResultResponse { browseEnginesResultResponseEngines :: [EngineEntry], browseEnginesResultResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseEnginesResultResponse where
  parseJSON = checked "BrowseEnginesResultResponse" $ withObject "BrowseEnginesResultResponse" (\fields -> BrowseEnginesResultResponse <$> fields .: "engines" <*> traverse parseJSON (withoutFields ["engines"] fields))
instance ToJSON BrowseEnginesResultResponse where toJSON value = Object (KM.fromList (concat [[("engines", toJSON (browseEnginesResultResponseEngines value))]]) <> fmap toJSON (withoutFields ["engines"] (browseEnginesResultResponseAdditionalProperties value)))
