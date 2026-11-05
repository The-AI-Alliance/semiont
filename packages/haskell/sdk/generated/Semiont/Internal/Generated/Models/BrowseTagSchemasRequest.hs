-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseTagSchemasRequest
  ( BrowseTagSchemasRequest(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data BrowseTagSchemasRequest = BrowseTagSchemasRequest { browseTagSchemasRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseTagSchemasRequest where
  parseJSON = checked "BrowseTagSchemasRequest" $ withObject "BrowseTagSchemasRequest" (\fields -> BrowseTagSchemasRequest <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON BrowseTagSchemasRequest where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (browseTagSchemasRequestAdditionalProperties value)))

