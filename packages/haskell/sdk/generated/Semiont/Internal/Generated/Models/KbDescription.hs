-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.KbDescription
  ( KbDescription(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data KbDescription = KbDescription { kbDescriptionDomain :: Text, kbDescriptionGitBranch :: Maybe (Text), kbDescriptionName :: Text, kbDescriptionAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON KbDescription where
  parseJSON = checked "KbDescription" $ withObject "KbDescription" (\fields -> KbDescription <$> fields .: "domain" <*> optional fields "gitBranch" <*> fields .: "name" <*> traverse parseJSON (withoutFields ["domain", "gitBranch", "name"] fields))
instance ToJSON KbDescription where toJSON value = Object (KM.fromList (concat [[("domain", toJSON (kbDescriptionDomain value))], optionalPair "gitBranch" (kbDescriptionGitBranch value), [("name", toJSON (kbDescriptionName value))]]) <> fmap toJSON (withoutFields ["domain", "gitBranch", "name"] (kbDescriptionAdditionalProperties value)))
