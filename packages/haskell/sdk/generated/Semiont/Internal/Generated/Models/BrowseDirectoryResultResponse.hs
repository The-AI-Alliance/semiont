-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseDirectoryResultResponse
  ( BrowseDirectoryResultResponse(..)
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
data BrowseDirectoryResultResponse = BrowseDirectoryResultResponse { browseDirectoryResultResponseEntries :: [DirectoryEntry], browseDirectoryResultResponsePath :: Text, browseDirectoryResultResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseDirectoryResultResponse where
  parseJSON = checked "BrowseDirectoryResultResponse" $ withObject "BrowseDirectoryResultResponse" (\fields -> BrowseDirectoryResultResponse <$> fields .: "entries" <*> fields .: "path" <*> traverse parseJSON (withoutFields ["entries", "path"] fields))
instance ToJSON BrowseDirectoryResultResponse where toJSON value = Object (KM.fromList (concat [[("entries", toJSON (browseDirectoryResultResponseEntries value))], [("path", toJSON (browseDirectoryResultResponsePath value))]]) <> fmap toJSON (withoutFields ["entries", "path"] (browseDirectoryResultResponseAdditionalProperties value)))
