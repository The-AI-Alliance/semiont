-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BusResumeGap
  ( BusResumeGap(..)
  , BusResumeGapReason(..)
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
data BusResumeGap = BusResumeGap { busResumeGapLastSeenId :: Text, busResumeGapReason :: BusResumeGapReason, busResumeGapScope :: ResourceId } deriving (Eq, Show)
instance FromJSON BusResumeGap where
  parseJSON = checked "BusResumeGap" $ withObject "BusResumeGap" (\fields -> BusResumeGap <$> fields .: "lastSeenId" <*> fields .: "reason" <*> fields .: "scope")
instance ToJSON BusResumeGap where toJSON value = Object (KM.fromList (concat [[("lastSeenId", toJSON (busResumeGapLastSeenId value))], [("reason", toJSON (busResumeGapReason value))], [("scope", toJSON (busResumeGapScope value))]]))

data BusResumeGapReason = BusResumeGapReasonUnparseableU2d_lastU2d_eventU2d_id | BusResumeGapReasonScopeU2d_mismatch | BusResumeGapReasonRetentionU2d_exceeded | BusResumeGapReasonQueryU2d_error deriving (Eq, Show)
instance FromJSON BusResumeGapReason where
  parseJSON = checked "BusResumeGapReason" $ \value -> if value == (String "unparseable-last-event-id") then pure BusResumeGapReasonUnparseableU2d_lastU2d_eventU2d_id else if value == (String "scope-mismatch") then pure BusResumeGapReasonScopeU2d_mismatch else if value == (String "retention-exceeded") then pure BusResumeGapReasonRetentionU2d_exceeded else if value == (String "query-error") then pure BusResumeGapReasonQueryU2d_error else fail "unknown enumeration member"
instance ToJSON BusResumeGapReason where
  toJSON BusResumeGapReasonUnparseableU2d_lastU2d_eventU2d_id = String "unparseable-last-event-id"
  toJSON BusResumeGapReasonScopeU2d_mismatch = String "scope-mismatch"
  toJSON BusResumeGapReasonRetentionU2d_exceeded = String "retention-exceeded"
  toJSON BusResumeGapReasonQueryU2d_error = String "query-error"


