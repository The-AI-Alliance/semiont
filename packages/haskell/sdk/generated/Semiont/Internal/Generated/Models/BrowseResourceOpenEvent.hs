-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseResourceOpenEvent
  ( BrowseResourceOpenEvent(..)
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
data BrowseResourceOpenEvent = BrowseResourceOpenEvent { browseResourceOpenEventResourceId :: ResourceId, browseResourceOpenEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseResourceOpenEvent where
  parseJSON = checked "BrowseResourceOpenEvent" $ withObject "BrowseResourceOpenEvent" (\fields -> BrowseResourceOpenEvent <$> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["resourceId"] fields))
instance ToJSON BrowseResourceOpenEvent where toJSON value = Object (KM.fromList (concat [[("resourceId", toJSON (browseResourceOpenEventResourceId value))]]) <> fmap toJSON (withoutFields ["resourceId"] (browseResourceOpenEventAdditionalProperties value)))

