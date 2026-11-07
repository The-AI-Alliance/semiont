-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.Profile
  ( Profile(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data Profile = Profile { profileName :: Text, profileSince :: Text } deriving (Eq, Show)
instance FromJSON Profile where
  parseJSON = checked "Profile" $ withObject "Profile" (\fields -> Profile <$> fields .: "name" <*> fields .: "since")
instance ToJSON Profile where toJSON value = Object (KM.fromList (concat [[("name", toJSON (profileName value))], [("since", toJSON (profileSince value))]]))
