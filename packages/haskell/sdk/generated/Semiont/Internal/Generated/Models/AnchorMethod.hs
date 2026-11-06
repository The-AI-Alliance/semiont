-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnchorMethod
  ( AnchorMethod(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data AnchorMethod = AnchorMethodUniqueU2d_match | AnchorMethodContextU2d_recovered | AnchorMethodFirstU2d_ofU2d_many | AnchorMethodFuzzyU2d_match deriving (Eq, Show)
instance FromJSON AnchorMethod where
  parseJSON = checked "AnchorMethod" $ \value -> if value == (String "unique-match") then pure AnchorMethodUniqueU2d_match else if value == (String "context-recovered") then pure AnchorMethodContextU2d_recovered else if value == (String "first-of-many") then pure AnchorMethodFirstU2d_ofU2d_many else if value == (String "fuzzy-match") then pure AnchorMethodFuzzyU2d_match else fail "unknown enumeration member"
instance ToJSON AnchorMethod where
  toJSON AnchorMethodUniqueU2d_match = String "unique-match"
  toJSON AnchorMethodContextU2d_recovered = String "context-recovered"
  toJSON AnchorMethodFirstU2d_ofU2d_many = String "first-of-many"
  toJSON AnchorMethodFuzzyU2d_match = String "fuzzy-match"
