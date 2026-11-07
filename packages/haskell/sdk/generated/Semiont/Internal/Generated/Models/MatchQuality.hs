-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MatchQuality
  ( MatchQuality(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data MatchQuality = MatchQualityNormalized | MatchQualityCaseU2d_insensitive | MatchQualityFuzzy deriving (Eq, Show)
instance FromJSON MatchQuality where
  parseJSON = checked "MatchQuality" $ \value -> if value == (String "normalized") then pure MatchQualityNormalized else if value == (String "case-insensitive") then pure MatchQualityCaseU2d_insensitive else if value == (String "fuzzy") then pure MatchQualityFuzzy else fail "unknown enumeration member"
instance ToJSON MatchQuality where
  toJSON MatchQualityNormalized = String "normalized"
  toJSON MatchQualityCaseU2d_insensitive = String "case-insensitive"
  toJSON MatchQualityFuzzy = String "fuzzy"
