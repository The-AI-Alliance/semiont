-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnchoredTextDeclinedEntry
  ( AnchoredTextDeclinedEntry(..)
  , AnchoredTextDeclinedEntryDeclined(..)
  , AnchoredTextDeclinedEntryV(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data AnchoredTextDeclinedEntry = AnchoredTextDeclinedEntry { anchoredTextDeclinedEntryDeclined :: AnchoredTextDeclinedEntryDeclined, anchoredTextDeclinedEntryStamp :: Text, anchoredTextDeclinedEntryV :: AnchoredTextDeclinedEntryV } deriving (Eq, Show)
instance FromJSON AnchoredTextDeclinedEntry where
  parseJSON = checked "AnchoredTextDeclinedEntry" $ withObject "AnchoredTextDeclinedEntry" (\fields -> AnchoredTextDeclinedEntry <$> fields .: "declined" <*> fields .: "stamp" <*> fields .: "v")
instance ToJSON AnchoredTextDeclinedEntry where toJSON value = Object (KM.fromList (concat [[("declined", toJSON (anchoredTextDeclinedEntryDeclined value))], [("stamp", toJSON (anchoredTextDeclinedEntryStamp value))], [("v", toJSON (anchoredTextDeclinedEntryV value))]]))

data AnchoredTextDeclinedEntryDeclined = AnchoredTextDeclinedEntryDeclinedNoU2d_textU2d_layer | AnchoredTextDeclinedEntryDeclinedEncrypted | AnchoredTextDeclinedEntryDeclinedCorrupt | AnchoredTextDeclinedEntryDeclinedTooU2d_large deriving (Eq, Show)
instance FromJSON AnchoredTextDeclinedEntryDeclined where
  parseJSON = checked "AnchoredTextDeclinedEntryDeclined" $ \value -> if value == (String "no-text-layer") then pure AnchoredTextDeclinedEntryDeclinedNoU2d_textU2d_layer else if value == (String "encrypted") then pure AnchoredTextDeclinedEntryDeclinedEncrypted else if value == (String "corrupt") then pure AnchoredTextDeclinedEntryDeclinedCorrupt else if value == (String "too-large") then pure AnchoredTextDeclinedEntryDeclinedTooU2d_large else fail "unknown enumeration member"
instance ToJSON AnchoredTextDeclinedEntryDeclined where
  toJSON AnchoredTextDeclinedEntryDeclinedNoU2d_textU2d_layer = String "no-text-layer"
  toJSON AnchoredTextDeclinedEntryDeclinedEncrypted = String "encrypted"
  toJSON AnchoredTextDeclinedEntryDeclinedCorrupt = String "corrupt"
  toJSON AnchoredTextDeclinedEntryDeclinedTooU2d_large = String "too-large"


data AnchoredTextDeclinedEntryV = AnchoredTextDeclinedEntryVV3U2e_0 deriving (Eq, Show)
instance FromJSON AnchoredTextDeclinedEntryV where
  parseJSON = checked "AnchoredTextDeclinedEntryV" $ \value -> if value == (Number (read "3.0")) then pure AnchoredTextDeclinedEntryVV3U2e_0 else fail "unknown enumeration member"
instance ToJSON AnchoredTextDeclinedEntryV where
  toJSON AnchoredTextDeclinedEntryVV3U2e_0 = Number (read "3.0")


