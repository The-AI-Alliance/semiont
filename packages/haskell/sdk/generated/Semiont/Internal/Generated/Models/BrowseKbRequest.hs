-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseKbRequest
  ( BrowseKbRequest(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data BrowseKbRequest = BrowseKbRequest { browseKbRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseKbRequest where
  parseJSON = checked "BrowseKbRequest" $ withObject "BrowseKbRequest" (\fields -> BrowseKbRequest <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON BrowseKbRequest where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (browseKbRequestAdditionalProperties value)))

