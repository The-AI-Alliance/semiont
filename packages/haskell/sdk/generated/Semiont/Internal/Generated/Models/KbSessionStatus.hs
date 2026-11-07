-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.KbSessionStatus
  ( KbSessionStatus(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data KbSessionStatus = KbSessionStatusAuthenticated | KbSessionStatusExpired | KbSessionStatusSignedU2d_out deriving (Eq, Show)
instance FromJSON KbSessionStatus where
  parseJSON = checked "KbSessionStatus" $ \value -> if value == (String "authenticated") then pure KbSessionStatusAuthenticated else if value == (String "expired") then pure KbSessionStatusExpired else if value == (String "signed-out") then pure KbSessionStatusSignedU2d_out else fail "unknown enumeration member"
instance ToJSON KbSessionStatus where
  toJSON KbSessionStatusAuthenticated = String "authenticated"
  toJSON KbSessionStatusExpired = String "expired"
  toJSON KbSessionStatusSignedU2d_out = String "signed-out"
