-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.CommandError
  ( CommandError(..)
  , CommandErrorCode(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data CommandError = CommandError { commandErrorCode :: Maybe (CommandErrorCode), commandErrorDetails :: Maybe (Text), commandErrorMessage :: Text, commandErrorAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON CommandError where
  parseJSON = checked "CommandError" $ withObject "CommandError" (\fields -> CommandError <$> optional fields "code" <*> optional fields "details" <*> fields .: "message" <*> traverse parseJSON (withoutFields ["code", "details", "message"] fields))
instance ToJSON CommandError where toJSON value = Object (KM.fromList (concat [optionalPair "code" (commandErrorCode value), optionalPair "details" (commandErrorDetails value), [("message", toJSON (commandErrorMessage value))]]) <> fmap toJSON (withoutFields ["code", "details", "message"] (commandErrorAdditionalProperties value)))

data CommandErrorCode = CommandErrorCodePeerU2d_unavailable | CommandErrorCodeNotU2d_found | CommandErrorCodeUnauthorized | CommandErrorCodeNoneU2d_pending deriving (Eq, Show)
instance FromJSON CommandErrorCode where
  parseJSON = checked "CommandErrorCode" $ \value -> if value == (String "peer-unavailable") then pure CommandErrorCodePeerU2d_unavailable else if value == (String "not-found") then pure CommandErrorCodeNotU2d_found else if value == (String "unauthorized") then pure CommandErrorCodeUnauthorized else if value == (String "none-pending") then pure CommandErrorCodeNoneU2d_pending else fail "unknown enumeration member"
instance ToJSON CommandErrorCode where
  toJSON CommandErrorCodePeerU2d_unavailable = String "peer-unavailable"
  toJSON CommandErrorCodeNotU2d_found = String "not-found"
  toJSON CommandErrorCodeUnauthorized = String "unauthorized"
  toJSON CommandErrorCodeNoneU2d_pending = String "none-pending"
