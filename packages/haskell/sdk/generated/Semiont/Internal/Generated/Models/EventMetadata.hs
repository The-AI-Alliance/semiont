-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.EventMetadata
  ( EventMetadata(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data EventMetadata = EventMetadata { eventMetadataSequenceNumber :: Integer, eventMetadataAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON EventMetadata where
  parseJSON = checked "EventMetadata" $ withObject "EventMetadata" (\fields -> EventMetadata <$> fields .: "sequenceNumber" <*> traverse parseJSON (withoutFields ["sequenceNumber"] fields))
instance ToJSON EventMetadata where toJSON value = Object (KM.fromList (concat [[("sequenceNumber", toJSON (eventMetadataSequenceNumber value))]]) <> fmap toJSON (withoutFields ["sequenceNumber"] (eventMetadataAdditionalProperties value)))
