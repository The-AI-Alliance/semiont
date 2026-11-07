-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseProfilesResult
  ( BrowseProfilesResult(..)
  , BrowseProfilesResultResponse(..)
  , BrowseProfilesResultResponseProfiles(..)
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
data BrowseProfilesResult = BrowseProfilesResult { browseProfilesResultResponse :: BrowseProfilesResultResponse, browseProfilesResultAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseProfilesResult where
  parseJSON = checked "BrowseProfilesResult" $ withObject "BrowseProfilesResult" (\fields -> BrowseProfilesResult <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON BrowseProfilesResult where toJSON value = Object (KM.fromList (concat [[("response", toJSON (browseProfilesResultResponse value))]]) <> fmap toJSON (withoutFields ["response"] (browseProfilesResultAdditionalProperties value)))

data BrowseProfilesResultResponse = BrowseProfilesResultResponse { browseProfilesResultResponseProfiles :: BrowseProfilesResultResponseProfiles } deriving (Eq, Show)
instance FromJSON BrowseProfilesResultResponse where
  parseJSON = checked "BrowseProfilesResultResponse" $ withObject "BrowseProfilesResultResponse" (\fields -> BrowseProfilesResultResponse <$> fields .: "profiles")
instance ToJSON BrowseProfilesResultResponse where toJSON value = Object (KM.fromList (concat [[("profiles", toJSON (browseProfilesResultResponseProfiles value))]]))

data BrowseProfilesResultResponseProfiles = BrowseProfilesResultResponseProfiles { browseProfilesResultResponseProfilesAdditionalProperties :: KM.KeyMap (Profile) } deriving (Eq, Show)
instance FromJSON BrowseProfilesResultResponseProfiles where
  parseJSON = checked "BrowseProfilesResultResponseProfiles" $ withObject "BrowseProfilesResultResponseProfiles" (\fields -> BrowseProfilesResultResponseProfiles <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON BrowseProfilesResultResponseProfiles where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (browseProfilesResultResponseProfilesAdditionalProperties value)))
