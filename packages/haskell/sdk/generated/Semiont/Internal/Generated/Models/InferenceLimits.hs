-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.InferenceLimits
  ( InferenceLimits(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data InferenceLimits = InferenceLimits { inferenceLimitsAcceptsTemperature :: Maybe (Bool), inferenceLimitsContextTokens :: Scientific, inferenceLimitsMaxOutputTokens :: Scientific, inferenceLimitsAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON InferenceLimits where
  parseJSON = checked "InferenceLimits" $ withObject "InferenceLimits" (\fields -> InferenceLimits <$> optional fields "acceptsTemperature" <*> fields .: "contextTokens" <*> fields .: "maxOutputTokens" <*> traverse parseJSON (withoutFields ["acceptsTemperature", "contextTokens", "maxOutputTokens"] fields))
instance ToJSON InferenceLimits where toJSON value = Object (KM.fromList (concat [optionalPair "acceptsTemperature" (inferenceLimitsAcceptsTemperature value), [("contextTokens", toJSON (inferenceLimitsContextTokens value))], [("maxOutputTokens", toJSON (inferenceLimitsMaxOutputTokens value))]]) <> fmap toJSON (withoutFields ["acceptsTemperature", "contextTokens", "maxOutputTokens"] (inferenceLimitsAdditionalProperties value)))
