-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AssessingJobParams
  ( AssessingJobParams(..)
  , AssessingJobParamsMotivation(..)
  , AssessingJobParamsTone(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data AssessingJobParams = AssessingJobParams { assessingJobParamsDensity :: Maybe (Scientific), assessingJobParamsInstructions :: Maybe (Text), assessingJobParamsLanguage :: Maybe (Text), assessingJobParamsMotivation :: AssessingJobParamsMotivation, assessingJobParamsSourceLanguage :: Maybe (Text), assessingJobParamsTone :: Maybe (AssessingJobParamsTone) } deriving (Eq, Show)
instance FromJSON AssessingJobParams where
  parseJSON = checked "AssessingJobParams" $ withObject "AssessingJobParams" (\fields -> AssessingJobParams <$> optional fields "density" <*> optional fields "instructions" <*> optional fields "language" <*> fields .: "motivation" <*> optional fields "sourceLanguage" <*> optional fields "tone")
instance ToJSON AssessingJobParams where toJSON value = Object (KM.fromList (concat [optionalPair "density" (assessingJobParamsDensity value), optionalPair "instructions" (assessingJobParamsInstructions value), optionalPair "language" (assessingJobParamsLanguage value), [("motivation", toJSON (assessingJobParamsMotivation value))], optionalPair "sourceLanguage" (assessingJobParamsSourceLanguage value), optionalPair "tone" (assessingJobParamsTone value)]))

data AssessingJobParamsMotivation = AssessingJobParamsMotivationAssessing deriving (Eq, Show)
instance FromJSON AssessingJobParamsMotivation where
  parseJSON = checked "AssessingJobParamsMotivation" $ \value -> if value == (String "assessing") then pure AssessingJobParamsMotivationAssessing else fail "unknown enumeration member"
instance ToJSON AssessingJobParamsMotivation where
  toJSON AssessingJobParamsMotivationAssessing = String "assessing"


data AssessingJobParamsTone = AssessingJobParamsToneAnalytical | AssessingJobParamsToneCritical | AssessingJobParamsToneBalanced | AssessingJobParamsToneConstructive deriving (Eq, Show)
instance FromJSON AssessingJobParamsTone where
  parseJSON = checked "AssessingJobParamsTone" $ \value -> if value == (String "analytical") then pure AssessingJobParamsToneAnalytical else if value == (String "critical") then pure AssessingJobParamsToneCritical else if value == (String "balanced") then pure AssessingJobParamsToneBalanced else if value == (String "constructive") then pure AssessingJobParamsToneConstructive else fail "unknown enumeration member"
instance ToJSON AssessingJobParamsTone where
  toJSON AssessingJobParamsToneAnalytical = String "analytical"
  toJSON AssessingJobParamsToneCritical = String "critical"
  toJSON AssessingJobParamsToneBalanced = String "balanced"
  toJSON AssessingJobParamsToneConstructive = String "constructive"
