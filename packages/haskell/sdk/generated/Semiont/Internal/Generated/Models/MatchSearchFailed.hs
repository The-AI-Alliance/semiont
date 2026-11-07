-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MatchSearchFailed
  ( MatchSearchFailed(..)
  , MatchSearchFailedCode(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnnotationId
data MatchSearchFailed = MatchSearchFailed { matchSearchFailedCode :: Maybe (MatchSearchFailedCode), matchSearchFailedDetails :: Maybe (Text), matchSearchFailedMessage :: Text, matchSearchFailedReferenceId :: AnnotationId, matchSearchFailedAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MatchSearchFailed where
  parseJSON = checked "MatchSearchFailed" $ withObject "MatchSearchFailed" (\fields -> MatchSearchFailed <$> optional fields "code" <*> optional fields "details" <*> fields .: "message" <*> fields .: "referenceId" <*> traverse parseJSON (withoutFields ["code", "details", "message", "referenceId"] fields))
instance ToJSON MatchSearchFailed where toJSON value = Object (KM.fromList (concat [optionalPair "code" (matchSearchFailedCode value), optionalPair "details" (matchSearchFailedDetails value), [("message", toJSON (matchSearchFailedMessage value))], [("referenceId", toJSON (matchSearchFailedReferenceId value))]]) <> fmap toJSON (withoutFields ["code", "details", "message", "referenceId"] (matchSearchFailedAdditionalProperties value)))

data MatchSearchFailedCode = MatchSearchFailedCodePeerU2d_unavailable | MatchSearchFailedCodeNotU2d_found | MatchSearchFailedCodeUnauthorized | MatchSearchFailedCodeNoneU2d_pending deriving (Eq, Show)
instance FromJSON MatchSearchFailedCode where
  parseJSON = checked "MatchSearchFailedCode" $ \value -> if value == (String "peer-unavailable") then pure MatchSearchFailedCodePeerU2d_unavailable else if value == (String "not-found") then pure MatchSearchFailedCodeNotU2d_found else if value == (String "unauthorized") then pure MatchSearchFailedCodeUnauthorized else if value == (String "none-pending") then pure MatchSearchFailedCodeNoneU2d_pending else fail "unknown enumeration member"
instance ToJSON MatchSearchFailedCode where
  toJSON MatchSearchFailedCodePeerU2d_unavailable = String "peer-unavailable"
  toJSON MatchSearchFailedCodeNotU2d_found = String "not-found"
  toJSON MatchSearchFailedCodeUnauthorized = String "unauthorized"
  toJSON MatchSearchFailedCodeNoneU2d_pending = String "none-pending"
