-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BusEmitRequest
  ( BusEmitRequest(..)
  , BusEmitRequestPayload(..)
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
data BusEmitRequest = BusEmitRequest { busEmitRequestChannel :: Text, busEmitRequestClientId :: Maybe (Text), busEmitRequestCorrelationId :: Maybe (Text), busEmitRequestPayload :: BusEmitRequestPayload, busEmitRequestScope :: Maybe (ResourceId), busEmitRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BusEmitRequest where
  parseJSON = checked "BusEmitRequest" $ withObject "BusEmitRequest" (\fields -> BusEmitRequest <$> fields .: "channel" <*> optional fields "clientId" <*> optional fields "correlationId" <*> fields .: "payload" <*> optional fields "scope" <*> traverse parseJSON (withoutFields ["channel", "clientId", "correlationId", "payload", "scope"] fields))
instance ToJSON BusEmitRequest where toJSON value = Object (KM.fromList (concat [[("channel", toJSON (busEmitRequestChannel value))], optionalPair "clientId" (busEmitRequestClientId value), optionalPair "correlationId" (busEmitRequestCorrelationId value), [("payload", toJSON (busEmitRequestPayload value))], optionalPair "scope" (busEmitRequestScope value)]) <> fmap toJSON (withoutFields ["channel", "clientId", "correlationId", "payload", "scope"] (busEmitRequestAdditionalProperties value)))

data BusEmitRequestPayload = BusEmitRequestPayload { busEmitRequestPayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BusEmitRequestPayload where
  parseJSON = checked "BusEmitRequestPayload" $ withObject "BusEmitRequestPayload" (\fields -> BusEmitRequestPayload <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON BusEmitRequestPayload where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (busEmitRequestPayloadAdditionalProperties value)))
