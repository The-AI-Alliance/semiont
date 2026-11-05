-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.KbIdentity
  ( KbIdentity(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data KbIdentity = KbIdentity { kbIdentityDomain :: Text, kbIdentityName :: Text } deriving (Eq, Show)
instance FromJSON KbIdentity where
  parseJSON = checked "KbIdentity" $ withObject "KbIdentity" (\fields -> KbIdentity <$> fields .: "domain" <*> fields .: "name")
instance ToJSON KbIdentity where toJSON value = Object (KM.fromList (concat [[("domain", toJSON (kbIdentityDomain value))], [("name", toJSON (kbIdentityName value))]]))

