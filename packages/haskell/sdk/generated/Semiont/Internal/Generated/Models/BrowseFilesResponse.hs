-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseFilesResponse
  ( BrowseFilesResponse(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.DirectoryEntry
data BrowseFilesResponse = BrowseFilesResponse { browseFilesResponseEntries :: [DirectoryEntry], browseFilesResponsePath :: Text } deriving (Eq, Show)
instance FromJSON BrowseFilesResponse where
  parseJSON = checked "BrowseFilesResponse" $ withObject "BrowseFilesResponse" (\fields -> BrowseFilesResponse <$> fields .: "entries" <*> fields .: "path")
instance ToJSON BrowseFilesResponse where toJSON value = Object (KM.fromList (concat [[("entries", toJSON (browseFilesResponseEntries value))], [("path", toJSON (browseFilesResponsePath value))]]))
