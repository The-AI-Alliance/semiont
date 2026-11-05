-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseResourceReorderEvent
  ( BrowseResourceReorderEvent(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data BrowseResourceReorderEvent = BrowseResourceReorderEvent { browseResourceReorderEventNewIndex :: Integer, browseResourceReorderEventOldIndex :: Integer, browseResourceReorderEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseResourceReorderEvent where
  parseJSON = checked "BrowseResourceReorderEvent" $ withObject "BrowseResourceReorderEvent" (\fields -> BrowseResourceReorderEvent <$> fields .: "newIndex" <*> fields .: "oldIndex" <*> traverse parseJSON (withoutFields ["newIndex", "oldIndex"] fields))
instance ToJSON BrowseResourceReorderEvent where toJSON value = Object (KM.fromList (concat [[("newIndex", toJSON (browseResourceReorderEventNewIndex value))], [("oldIndex", toJSON (browseResourceReorderEventOldIndex value))]]) <> fmap toJSON (withoutFields ["newIndex", "oldIndex"] (browseResourceReorderEventAdditionalProperties value)))
