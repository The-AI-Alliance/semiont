-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.InferenceLimitsResult
  ( InferenceLimitsResult(..)
  , InferenceLimitsResultResponse(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.EngineLimits
data InferenceLimitsResult = InferenceLimitsResult { inferenceLimitsResultResponse :: InferenceLimitsResultResponse, inferenceLimitsResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON InferenceLimitsResult where
  parseJSON = checked "InferenceLimitsResult" $ withObject "InferenceLimitsResult" (\fields -> InferenceLimitsResult <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON InferenceLimitsResult where toJSON value = Object (KM.fromList (concat [[("response", toJSON (inferenceLimitsResultResponse value))]]) <> fmap toJSON (withoutFields ["response"] (inferenceLimitsResultAdditionalProperties value)))

data InferenceLimitsResultResponse = InferenceLimitsResultResponse { inferenceLimitsResultResponseLimits :: [EngineLimits], inferenceLimitsResultResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON InferenceLimitsResultResponse where
  parseJSON = checked "InferenceLimitsResultResponse" $ withObject "InferenceLimitsResultResponse" (\fields -> InferenceLimitsResultResponse <$> fields .: "limits" <*> traverse parseJSON (withoutFields ["limits"] fields))
instance ToJSON InferenceLimitsResultResponse where toJSON value = Object (KM.fromList (concat [[("limits", toJSON (inferenceLimitsResultResponseLimits value))]]) <> fmap toJSON (withoutFields ["limits"] (inferenceLimitsResultResponseAdditionalProperties value)))

