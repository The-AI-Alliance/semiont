-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.TraceCarrier
  ( TraceCarrier(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data TraceCarrier = TraceCarrier { traceCarrierTraceparent :: Text, traceCarrierTracestate :: Maybe (Text) } deriving (Eq, Show)
instance FromJSON TraceCarrier where
  parseJSON = checked "TraceCarrier" $ withObject "TraceCarrier" (\fields -> TraceCarrier <$> fields .: "traceparent" <*> optional fields "tracestate")
instance ToJSON TraceCarrier where toJSON value = Object (KM.fromList (concat [[("traceparent", toJSON (traceCarrierTraceparent value))], optionalPair "tracestate" (traceCarrierTracestate value)]))
