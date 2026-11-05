-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.DurabilityEvidence
  ( DurabilityEvidence(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data DurabilityEvidence = DurabilityEvidenceAcknowledged | DurabilityEvidenceProbeU2d_confirmed | DurabilityEvidenceProbeU2d_refused | DurabilityEvidenceProbeU2d_unreachable deriving (Eq, Show)
instance FromJSON DurabilityEvidence where
  parseJSON = checked "DurabilityEvidence" $ \value -> if value == (String "acknowledged") then pure DurabilityEvidenceAcknowledged else if value == (String "probe-confirmed") then pure DurabilityEvidenceProbeU2d_confirmed else if value == (String "probe-refused") then pure DurabilityEvidenceProbeU2d_refused else if value == (String "probe-unreachable") then pure DurabilityEvidenceProbeU2d_unreachable else fail "unknown enumeration member"
instance ToJSON DurabilityEvidence where
  toJSON DurabilityEvidenceAcknowledged = String "acknowledged"
  toJSON DurabilityEvidenceProbeU2d_confirmed = String "probe-confirmed"
  toJSON DurabilityEvidenceProbeU2d_refused = String "probe-refused"
  toJSON DurabilityEvidenceProbeU2d_unreachable = String "probe-unreachable"
