-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GetEventsResponse
  ( GetEventsResponse(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AttributedEvent
import Semiont.Internal.Generated.Models.ResourceId
data GetEventsResponse = GetEventsResponse { getEventsResponseEvents :: [AttributedEvent], getEventsResponseResourceId :: ResourceId, getEventsResponseTotal :: Scientific, getEventsResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GetEventsResponse where
  parseJSON = checked "GetEventsResponse" $ withObject "GetEventsResponse" (\fields -> GetEventsResponse <$> fields .: "events" <*> fields .: "resourceId" <*> fields .: "total" <*> traverse parseJSON (withoutFields ["events", "resourceId", "total"] fields))
instance ToJSON GetEventsResponse where toJSON value = Object (KM.fromList (concat [[("events", toJSON (getEventsResponseEvents value))], [("resourceId", toJSON (getEventsResponseResourceId value))], [("total", toJSON (getEventsResponseTotal value))]]) <> fmap toJSON (withoutFields ["events", "resourceId", "total"] (getEventsResponseAdditionalProperties value)))

