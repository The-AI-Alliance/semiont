-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseEntityTypeClickedEvent
  ( BrowseEntityTypeClickedEvent(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data BrowseEntityTypeClickedEvent = BrowseEntityTypeClickedEvent { browseEntityTypeClickedEventEntityType :: Text, browseEntityTypeClickedEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseEntityTypeClickedEvent where
  parseJSON = checked "BrowseEntityTypeClickedEvent" $ withObject "BrowseEntityTypeClickedEvent" (\fields -> BrowseEntityTypeClickedEvent <$> fields .: "entityType" <*> traverse parseJSON (withoutFields ["entityType"] fields))
instance ToJSON BrowseEntityTypeClickedEvent where toJSON value = Object (KM.fromList (concat [[("entityType", toJSON (browseEntityTypeClickedEventEntityType value))]]) <> fmap toJSON (withoutFields ["entityType"] (browseEntityTypeClickedEventAdditionalProperties value)))

