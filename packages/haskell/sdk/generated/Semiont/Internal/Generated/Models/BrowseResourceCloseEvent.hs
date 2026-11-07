-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseResourceCloseEvent
  ( BrowseResourceCloseEvent(..)
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
data BrowseResourceCloseEvent = BrowseResourceCloseEvent { browseResourceCloseEventResourceId :: ResourceId, browseResourceCloseEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseResourceCloseEvent where
  parseJSON = checked "BrowseResourceCloseEvent" $ withObject "BrowseResourceCloseEvent" (\fields -> BrowseResourceCloseEvent <$> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["resourceId"] fields))
instance ToJSON BrowseResourceCloseEvent where toJSON value = Object (KM.fromList (concat [[("resourceId", toJSON (browseResourceCloseEventResourceId value))]]) <> fmap toJSON (withoutFields ["resourceId"] (browseResourceCloseEventAdditionalProperties value)))
