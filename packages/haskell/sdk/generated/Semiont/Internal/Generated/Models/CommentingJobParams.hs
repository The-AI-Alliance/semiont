-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.CommentingJobParams
  ( CommentingJobParams(..)
  , CommentingJobParamsMotivation(..)
  , CommentingJobParamsTone(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data CommentingJobParams = CommentingJobParams { commentingJobParamsDensity :: Maybe (Scientific), commentingJobParamsInstructions :: Maybe (Text), commentingJobParamsLanguage :: Maybe (Text), commentingJobParamsMotivation :: CommentingJobParamsMotivation, commentingJobParamsSourceLanguage :: Maybe (Text), commentingJobParamsTone :: Maybe (CommentingJobParamsTone) } deriving (Eq, Show)
instance FromJSON CommentingJobParams where
  parseJSON = checked "CommentingJobParams" $ withObject "CommentingJobParams" (\fields -> CommentingJobParams <$> optional fields "density" <*> optional fields "instructions" <*> optional fields "language" <*> fields .: "motivation" <*> optional fields "sourceLanguage" <*> optional fields "tone")
instance ToJSON CommentingJobParams where toJSON value = Object (KM.fromList (concat [optionalPair "density" (commentingJobParamsDensity value), optionalPair "instructions" (commentingJobParamsInstructions value), optionalPair "language" (commentingJobParamsLanguage value), [("motivation", toJSON (commentingJobParamsMotivation value))], optionalPair "sourceLanguage" (commentingJobParamsSourceLanguage value), optionalPair "tone" (commentingJobParamsTone value)]))

data CommentingJobParamsMotivation = CommentingJobParamsMotivationCommenting deriving (Eq, Show)
instance FromJSON CommentingJobParamsMotivation where
  parseJSON = checked "CommentingJobParamsMotivation" $ \value -> if value == (String "commenting") then pure CommentingJobParamsMotivationCommenting else fail "unknown enumeration member"
instance ToJSON CommentingJobParamsMotivation where
  toJSON CommentingJobParamsMotivationCommenting = String "commenting"


data CommentingJobParamsTone = CommentingJobParamsToneScholarly | CommentingJobParamsToneExplanatory | CommentingJobParamsToneConversational | CommentingJobParamsToneTechnical deriving (Eq, Show)
instance FromJSON CommentingJobParamsTone where
  parseJSON = checked "CommentingJobParamsTone" $ \value -> if value == (String "scholarly") then pure CommentingJobParamsToneScholarly else if value == (String "explanatory") then pure CommentingJobParamsToneExplanatory else if value == (String "conversational") then pure CommentingJobParamsToneConversational else if value == (String "technical") then pure CommentingJobParamsToneTechnical else fail "unknown enumeration member"
instance ToJSON CommentingJobParamsTone where
  toJSON CommentingJobParamsToneScholarly = String "scholarly"
  toJSON CommentingJobParamsToneExplanatory = String "explanatory"
  toJSON CommentingJobParamsToneConversational = String "conversational"
  toJSON CommentingJobParamsToneTechnical = String "technical"


