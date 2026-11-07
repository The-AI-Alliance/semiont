-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseKbResult
  ( BrowseKbResult(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.KbDescription
data BrowseKbResult = BrowseKbResult { browseKbResultResponse :: KbDescription, browseKbResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseKbResult where
  parseJSON = checked "BrowseKbResult" $ withObject "BrowseKbResult" (\fields -> BrowseKbResult <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON BrowseKbResult where toJSON value = Object (KM.fromList (concat [[("response", toJSON (browseKbResultResponse value))]]) <> fmap toJSON (withoutFields ["response"] (browseKbResultAdditionalProperties value)))
