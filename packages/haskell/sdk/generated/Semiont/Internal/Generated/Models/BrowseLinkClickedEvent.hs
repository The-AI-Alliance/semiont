-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseLinkClickedEvent
  ( BrowseLinkClickedEvent(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data BrowseLinkClickedEvent = BrowseLinkClickedEvent { browseLinkClickedEventHref :: Text, browseLinkClickedEventLabel :: Maybe (Text), browseLinkClickedEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseLinkClickedEvent where
  parseJSON = checked "BrowseLinkClickedEvent" $ withObject "BrowseLinkClickedEvent" (\fields -> BrowseLinkClickedEvent <$> fields .: "href" <*> optional fields "label" <*> traverse parseJSON (withoutFields ["href", "label"] fields))
instance ToJSON BrowseLinkClickedEvent where toJSON value = Object (KM.fromList (concat [[("href", toJSON (browseLinkClickedEventHref value))], optionalPair "label" (browseLinkClickedEventLabel value)]) <> fmap toJSON (withoutFields ["href", "label"] (browseLinkClickedEventAdditionalProperties value)))
