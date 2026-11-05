-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.FailureClass
  ( FailureClass(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data FailureClass = FailureClassTransient | FailureClassDeterministic | FailureClassWithheld deriving (Eq, Show)
instance FromJSON FailureClass where
  parseJSON = checked "FailureClass" $ \value -> if value == (String "transient") then pure FailureClassTransient else if value == (String "deterministic") then pure FailureClassDeterministic else if value == (String "withheld") then pure FailureClassWithheld else fail "unknown enumeration member"
instance ToJSON FailureClass where
  toJSON FailureClassTransient = String "transient"
  toJSON FailureClassDeterministic = String "deterministic"
  toJSON FailureClassWithheld = String "withheld"


