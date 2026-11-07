-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.KbIdentityConflict
  ( KbIdentityConflict(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data KbIdentityConflict = KbIdentityConflict { kbIdentityConflictExpectedDid :: Text, kbIdentityConflictObservedDid :: Text } deriving (Eq, Show)
instance FromJSON KbIdentityConflict where
  parseJSON = checked "KbIdentityConflict" $ withObject "KbIdentityConflict" (\fields -> KbIdentityConflict <$> fields .: "expectedDid" <*> fields .: "observedDid")
instance ToJSON KbIdentityConflict where toJSON value = Object (KM.fromList (concat [[("expectedDid", toJSON (kbIdentityConflictExpectedDid value))], [("observedDid", toJSON (kbIdentityConflictObservedDid value))]]))
