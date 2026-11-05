-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobDeclined
  ( JobDeclined(..)
  , JobDeclinedDeclined(..)
  , JobDeclinedReason(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data JobDeclined = JobDeclined { jobDeclinedDeclined :: JobDeclinedDeclined, jobDeclinedReason :: JobDeclinedReason } deriving (Eq, Show)
instance FromJSON JobDeclined where
  parseJSON = checked "JobDeclined" $ withObject "JobDeclined" (\fields -> JobDeclined <$> fields .: "declined" <*> fields .: "reason")
instance ToJSON JobDeclined where toJSON value = Object (KM.fromList (concat [[("declined", toJSON (jobDeclinedDeclined value))], [("reason", toJSON (jobDeclinedReason value))]]))

data JobDeclinedDeclined = JobDeclinedDeclinedTrue deriving (Eq, Show)
instance FromJSON JobDeclinedDeclined where
  parseJSON = checked "JobDeclinedDeclined" $ \value -> if value == (Bool True) then pure JobDeclinedDeclinedTrue else fail "unknown enumeration member"
instance ToJSON JobDeclinedDeclined where
  toJSON JobDeclinedDeclinedTrue = Bool True


data JobDeclinedReason = JobDeclinedReasonNoU2d_textU2d_layer | JobDeclinedReasonEncrypted | JobDeclinedReasonCorrupt | JobDeclinedReasonTooU2d_large | JobDeclinedReasonEmpty deriving (Eq, Show)
instance FromJSON JobDeclinedReason where
  parseJSON = checked "JobDeclinedReason" $ \value -> if value == (String "no-text-layer") then pure JobDeclinedReasonNoU2d_textU2d_layer else if value == (String "encrypted") then pure JobDeclinedReasonEncrypted else if value == (String "corrupt") then pure JobDeclinedReasonCorrupt else if value == (String "too-large") then pure JobDeclinedReasonTooU2d_large else if value == (String "empty") then pure JobDeclinedReasonEmpty else fail "unknown enumeration member"
instance ToJSON JobDeclinedReason where
  toJSON JobDeclinedReasonNoU2d_textU2d_layer = String "no-text-layer"
  toJSON JobDeclinedReasonEncrypted = String "encrypted"
  toJSON JobDeclinedReasonCorrupt = String "corrupt"
  toJSON JobDeclinedReasonTooU2d_large = String "too-large"
  toJSON JobDeclinedReasonEmpty = String "empty"


