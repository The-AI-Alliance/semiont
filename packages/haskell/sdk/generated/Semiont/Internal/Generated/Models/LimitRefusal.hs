-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.LimitRefusal
  ( LimitRefusal(..)
  , LimitRefusalCode(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data LimitRefusal = LimitRefusal { limitRefusalCode :: LimitRefusalCode, limitRefusalDetails :: Maybe (Value), limitRefusalError :: Text, limitRefusalHint :: Maybe (Text), limitRefusalAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON LimitRefusal where
  parseJSON = checked "LimitRefusal" $ withObject "LimitRefusal" (\fields -> LimitRefusal <$> fields .: "code" <*> optional fields "details" <*> fields .: "error" <*> optional fields "hint" <*> traverse parseJSON (withoutFields ["code", "details", "error", "hint"] fields))
instance ToJSON LimitRefusal where toJSON value = Object (KM.fromList (concat [[("code", toJSON (limitRefusalCode value))], optionalPair "details" (limitRefusalDetails value), [("error", toJSON (limitRefusalError value))], optionalPair "hint" (limitRefusalHint value)]) <> fmap toJSON (withoutFields ["code", "details", "error", "hint"] (limitRefusalAdditionalProperties value)))

data LimitRefusalCode = LimitRefusalCodeStreams | LimitRefusalCodeEmitU2d_rate | LimitRefusalCodeUnansweredU2d_requests | LimitRefusalCodeCapacity | LimitRefusalCodeRefusalU2d_rate deriving (Eq, Show)
instance FromJSON LimitRefusalCode where
  parseJSON = checked "LimitRefusalCode" $ \value -> if value == (String "streams") then pure LimitRefusalCodeStreams else if value == (String "emit-rate") then pure LimitRefusalCodeEmitU2d_rate else if value == (String "unanswered-requests") then pure LimitRefusalCodeUnansweredU2d_requests else if value == (String "capacity") then pure LimitRefusalCodeCapacity else if value == (String "refusal-rate") then pure LimitRefusalCodeRefusalU2d_rate else fail "unknown enumeration member"
instance ToJSON LimitRefusalCode where
  toJSON LimitRefusalCodeStreams = String "streams"
  toJSON LimitRefusalCodeEmitU2d_rate = String "emit-rate"
  toJSON LimitRefusalCodeUnansweredU2d_requests = String "unanswered-requests"
  toJSON LimitRefusalCodeCapacity = String "capacity"
  toJSON LimitRefusalCodeRefusalU2d_rate = String "refusal-rate"
