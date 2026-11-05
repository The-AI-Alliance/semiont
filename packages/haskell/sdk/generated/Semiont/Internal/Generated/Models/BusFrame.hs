-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BusFrame
  ( BusFrame(..)
  , BusFramePayload(..)
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
data BusFrame = BusFrame { busFrameChannel :: Text, busFrameCorrelationId :: Maybe (Text), busFramePayload :: BusFramePayload, busFrameScope :: Maybe (ResourceId) } deriving (Eq, Show)
instance FromJSON BusFrame where
  parseJSON = checked "BusFrame" $ withObject "BusFrame" (\fields -> BusFrame <$> fields .: "channel" <*> optional fields "correlationId" <*> fields .: "payload" <*> optional fields "scope")
instance ToJSON BusFrame where toJSON value = Object (KM.fromList (concat [[("channel", toJSON (busFrameChannel value))], optionalPair "correlationId" (busFrameCorrelationId value), [("payload", toJSON (busFramePayload value))], optionalPair "scope" (busFrameScope value)]))

data BusFramePayload = BusFramePayload { busFramePayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BusFramePayload where
  parseJSON = checked "BusFramePayload" $ withObject "BusFramePayload" (\fields -> BusFramePayload <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON BusFramePayload where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (busFramePayloadAdditionalProperties value)))

