-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnchoredTextWrite
  ( AnchoredTextWrite(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnchoredTextEntry
data AnchoredTextWrite = AnchoredTextWrite { anchoredTextWriteContentChecksum :: Text, anchoredTextWriteEntry :: AnchoredTextEntry } deriving (Eq, Show)
instance FromJSON AnchoredTextWrite where
  parseJSON = checked "AnchoredTextWrite" $ withObject "AnchoredTextWrite" (\fields -> AnchoredTextWrite <$> fields .: "contentChecksum" <*> fields .: "entry")
instance ToJSON AnchoredTextWrite where toJSON value = Object (KM.fromList (concat [[("contentChecksum", toJSON (anchoredTextWriteContentChecksum value))], [("entry", toJSON (anchoredTextWriteEntry value))]]))
