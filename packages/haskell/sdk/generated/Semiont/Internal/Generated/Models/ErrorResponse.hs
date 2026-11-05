-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ErrorResponse
  ( ErrorResponse(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data ErrorResponse = ErrorResponse { errorResponseCode :: Maybe (Text), errorResponseDetails :: Maybe (Value), errorResponseError :: Text, errorResponseHint :: Maybe (Text), errorResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ErrorResponse where
  parseJSON = checked "ErrorResponse" $ withObject "ErrorResponse" (\fields -> ErrorResponse <$> optional fields "code" <*> optional fields "details" <*> fields .: "error" <*> optional fields "hint" <*> traverse parseJSON (withoutFields ["code", "details", "error", "hint"] fields))
instance ToJSON ErrorResponse where toJSON value = Object (KM.fromList (concat [optionalPair "code" (errorResponseCode value), optionalPair "details" (errorResponseDetails value), [("error", toJSON (errorResponseError value))], optionalPair "hint" (errorResponseHint value)]) <> fmap toJSON (withoutFields ["code", "details", "error", "hint"] (errorResponseAdditionalProperties value)))

