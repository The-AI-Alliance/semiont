-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ProfilesProjection
  ( ProfilesProjection(..)
  , ProfilesProjectionProfiles(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Profile
data ProfilesProjection = ProfilesProjection { profilesProjectionProfiles :: ProfilesProjectionProfiles } deriving (Eq, Show)
instance FromJSON ProfilesProjection where
  parseJSON = checked "ProfilesProjection" $ withObject "ProfilesProjection" (\fields -> ProfilesProjection <$> fields .: "profiles")
instance ToJSON ProfilesProjection where toJSON value = Object (KM.fromList (concat [[("profiles", toJSON (profilesProjectionProfiles value))]]))

data ProfilesProjectionProfiles = ProfilesProjectionProfiles { profilesProjectionProfilesAdditionalProperties :: KM.KeyMap (Profile) } deriving (Eq, Show)
instance FromJSON ProfilesProjectionProfiles where
  parseJSON = checked "ProfilesProjectionProfiles" $ withObject "ProfilesProjectionProfiles" (\fields -> ProfilesProjectionProfiles <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON ProfilesProjectionProfiles where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (profilesProjectionProfilesAdditionalProperties value)))
