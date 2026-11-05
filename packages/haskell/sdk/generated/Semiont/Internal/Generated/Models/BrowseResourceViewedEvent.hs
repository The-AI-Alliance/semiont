-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseResourceViewedEvent
  ( BrowseResourceViewedEvent(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.ResourceId
data BrowseResourceViewedEvent = BrowseResourceViewedEvent { browseResourceViewedEventResourceId :: ResourceId, browseResourceViewedEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseResourceViewedEvent where
  parseJSON = checked "BrowseResourceViewedEvent" $ withObject "BrowseResourceViewedEvent" (\fields -> BrowseResourceViewedEvent <$> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["resourceId"] fields))
instance ToJSON BrowseResourceViewedEvent where toJSON value = Object (KM.fromList (concat [[("resourceId", toJSON (browseResourceViewedEventResourceId value))]]) <> fmap toJSON (withoutFields ["resourceId"] (browseResourceViewedEventAdditionalProperties value)))

