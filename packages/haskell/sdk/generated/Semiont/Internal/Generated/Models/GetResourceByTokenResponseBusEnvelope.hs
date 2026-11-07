-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GetResourceByTokenResponseBusEnvelope
  ( GetResourceByTokenResponseBusEnvelope(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.GetResourceByTokenResponse
data GetResourceByTokenResponseBusEnvelope = GetResourceByTokenResponseBusEnvelope { getResourceByTokenResponseBusEnvelopeResponse :: GetResourceByTokenResponse } deriving (Eq, Show)
instance FromJSON GetResourceByTokenResponseBusEnvelope where
  parseJSON = checked "GetResourceByTokenResponseBusEnvelope" $ withObject "GetResourceByTokenResponseBusEnvelope" (\fields -> GetResourceByTokenResponseBusEnvelope <$> fields .: "response")
instance ToJSON GetResourceByTokenResponseBusEnvelope where toJSON value = Object (KM.fromList (concat [[("response", toJSON (getResourceByTokenResponseBusEnvelopeResponse value))]]))
