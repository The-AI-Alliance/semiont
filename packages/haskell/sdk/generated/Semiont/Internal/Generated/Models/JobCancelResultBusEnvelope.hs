-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobCancelResultBusEnvelope
  ( JobCancelResultBusEnvelope(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.JobCancelResult
data JobCancelResultBusEnvelope = JobCancelResultBusEnvelope { jobCancelResultBusEnvelopeResponse :: JobCancelResult } deriving (Eq, Show)
instance FromJSON JobCancelResultBusEnvelope where
  parseJSON = checked "JobCancelResultBusEnvelope" $ withObject "JobCancelResultBusEnvelope" (\fields -> JobCancelResultBusEnvelope <$> fields .: "response")
instance ToJSON JobCancelResultBusEnvelope where toJSON value = Object (KM.fromList (concat [[("response", toJSON (jobCancelResultBusEnvelopeResponse value))]]))
