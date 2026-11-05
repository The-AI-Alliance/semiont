-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseDirectoryResult
  ( BrowseDirectoryResult(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.BrowseDirectoryResultResponse
data BrowseDirectoryResult = BrowseDirectoryResult { browseDirectoryResultResponse :: BrowseDirectoryResultResponse, browseDirectoryResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseDirectoryResult where
  parseJSON = checked "BrowseDirectoryResult" $ withObject "BrowseDirectoryResult" (\fields -> BrowseDirectoryResult <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON BrowseDirectoryResult where toJSON value = Object (KM.fromList (concat [[("response", toJSON (browseDirectoryResultResponse value))]]) <> fmap toJSON (withoutFields ["response"] (browseDirectoryResultAdditionalProperties value)))

