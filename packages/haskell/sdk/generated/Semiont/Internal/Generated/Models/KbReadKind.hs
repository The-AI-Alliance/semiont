-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.KbReadKind
  ( KbReadKind(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data KbReadKind = KbReadKindRecorded | KbReadKindConflict | KbReadKindNoU2d_verdict deriving (Eq, Show)
instance FromJSON KbReadKind where
  parseJSON = checked "KbReadKind" $ \value -> if value == (String "recorded") then pure KbReadKindRecorded else if value == (String "conflict") then pure KbReadKindConflict else if value == (String "no-verdict") then pure KbReadKindNoU2d_verdict else fail "unknown enumeration member"
instance ToJSON KbReadKind where
  toJSON KbReadKindRecorded = String "recorded"
  toJSON KbReadKindConflict = String "conflict"
  toJSON KbReadKindNoU2d_verdict = String "no-verdict"
