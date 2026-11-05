-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GatherResourceFailed
  ( GatherResourceFailed(..)
  , GatherResourceFailedCode(..)
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
data GatherResourceFailed = GatherResourceFailed { gatherResourceFailedCode :: Maybe (GatherResourceFailedCode), gatherResourceFailedDetails :: Maybe (Text), gatherResourceFailedMessage :: Text, gatherResourceFailedResourceId :: ResourceId, gatherResourceFailedAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatherResourceFailed where
  parseJSON = checked "GatherResourceFailed" $ withObject "GatherResourceFailed" (\fields -> GatherResourceFailed <$> optional fields "code" <*> optional fields "details" <*> fields .: "message" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["code", "details", "message", "resourceId"] fields))
instance ToJSON GatherResourceFailed where toJSON value = Object (KM.fromList (concat [optionalPair "code" (gatherResourceFailedCode value), optionalPair "details" (gatherResourceFailedDetails value), [("message", toJSON (gatherResourceFailedMessage value))], [("resourceId", toJSON (gatherResourceFailedResourceId value))]]) <> fmap toJSON (withoutFields ["code", "details", "message", "resourceId"] (gatherResourceFailedAdditionalProperties value)))

data GatherResourceFailedCode = GatherResourceFailedCodePeerU2d_unavailable | GatherResourceFailedCodeNotU2d_found | GatherResourceFailedCodeUnauthorized | GatherResourceFailedCodeNoneU2d_pending deriving (Eq, Show)
instance FromJSON GatherResourceFailedCode where
  parseJSON = checked "GatherResourceFailedCode" $ \value -> if value == (String "peer-unavailable") then pure GatherResourceFailedCodePeerU2d_unavailable else if value == (String "not-found") then pure GatherResourceFailedCodeNotU2d_found else if value == (String "unauthorized") then pure GatherResourceFailedCodeUnauthorized else if value == (String "none-pending") then pure GatherResourceFailedCodeNoneU2d_pending else fail "unknown enumeration member"
instance ToJSON GatherResourceFailedCode where
  toJSON GatherResourceFailedCodePeerU2d_unavailable = String "peer-unavailable"
  toJSON GatherResourceFailedCodeNotU2d_found = String "not-found"
  toJSON GatherResourceFailedCodeUnauthorized = String "unauthorized"
  toJSON GatherResourceFailedCodeNoneU2d_pending = String "none-pending"


