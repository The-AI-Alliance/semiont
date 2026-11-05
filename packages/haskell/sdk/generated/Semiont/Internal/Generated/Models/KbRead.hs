-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.KbRead
  ( KbRead(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data KbRead = KbRead { kbReadAt :: Text, kbReadGitBranch :: Maybe (Text), kbReadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON KbRead where
  parseJSON = checked "KbRead" $ withObject "KbRead" (\fields -> KbRead <$> fields .: "at" <*> optional fields "gitBranch" <*> traverse parseJSON (withoutFields ["at", "gitBranch"] fields))
instance ToJSON KbRead where toJSON value = Object (KM.fromList (concat [[("at", toJSON (kbReadAt value))], optionalPair "gitBranch" (kbReadGitBranch value)]) <> fmap toJSON (withoutFields ["at", "gitBranch"] (kbReadAdditionalProperties value)))

