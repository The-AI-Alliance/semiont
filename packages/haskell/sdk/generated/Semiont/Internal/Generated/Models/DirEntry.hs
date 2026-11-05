-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.DirEntry
  ( DirEntry(..)
  , DirEntryType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data DirEntry = DirEntry { dirEntryMtime :: Text, dirEntryName :: Text, dirEntryPath :: Text, dirEntryType :: DirEntryType } deriving (Eq, Show)
instance FromJSON DirEntry where
  parseJSON = checked "DirEntry" $ withObject "DirEntry" (\fields -> DirEntry <$> fields .: "mtime" <*> fields .: "name" <*> fields .: "path" <*> fields .: "type")
instance ToJSON DirEntry where toJSON value = Object (KM.fromList (concat [[("mtime", toJSON (dirEntryMtime value))], [("name", toJSON (dirEntryName value))], [("path", toJSON (dirEntryPath value))], [("type", toJSON (dirEntryType value))]]))

data DirEntryType = DirEntryTypeDir deriving (Eq, Show)
instance FromJSON DirEntryType where
  parseJSON = checked "DirEntryType" $ \value -> if value == (String "dir") then pure DirEntryTypeDir else fail "unknown enumeration member"
instance ToJSON DirEntryType where
  toJSON DirEntryTypeDir = String "dir"


