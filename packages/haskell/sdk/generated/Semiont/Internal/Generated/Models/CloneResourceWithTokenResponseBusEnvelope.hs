-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.CloneResourceWithTokenResponseBusEnvelope
  ( CloneResourceWithTokenResponseBusEnvelope(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.CloneResourceWithTokenResponse
data CloneResourceWithTokenResponseBusEnvelope = CloneResourceWithTokenResponseBusEnvelope { cloneResourceWithTokenResponseBusEnvelopeResponse :: CloneResourceWithTokenResponse } deriving (Eq, Show)
instance FromJSON CloneResourceWithTokenResponseBusEnvelope where
  parseJSON = checked "CloneResourceWithTokenResponseBusEnvelope" $ withObject "CloneResourceWithTokenResponseBusEnvelope" (\fields -> CloneResourceWithTokenResponseBusEnvelope <$> fields .: "response")
instance ToJSON CloneResourceWithTokenResponseBusEnvelope where toJSON value = Object (KM.fromList (concat [[("response", toJSON (cloneResourceWithTokenResponseBusEnvelopeResponse value))]]))
