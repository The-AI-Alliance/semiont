-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnchoredTextEntry
  ( AnchoredTextEntry(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnchoredTextDeclinedEntry
import Semiont.Internal.Generated.Models.AnchoredTextExtractedEntry
data AnchoredTextEntry = AnchoredTextEntryBranch1 (AnchoredTextExtractedEntry) | AnchoredTextEntryBranch2 (AnchoredTextDeclinedEntry) deriving (Eq, Show)
instance FromJSON AnchoredTextEntry where
  parseJSON = checked "AnchoredTextEntry" $ \value -> (AnchoredTextEntryBranch1 <$> parseJSON value) <|> (AnchoredTextEntryBranch2 <$> parseJSON value)
instance ToJSON AnchoredTextEntry where
  toJSON (AnchoredTextEntryBranch1 value) = toJSON value
  toJSON (AnchoredTextEntryBranch2 value) = toJSON value
