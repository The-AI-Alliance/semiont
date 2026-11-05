-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseDirectoryRequest
  ( BrowseDirectoryRequest(..)
  , BrowseDirectoryRequestSort(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data BrowseDirectoryRequest = BrowseDirectoryRequest { browseDirectoryRequestPath :: Text, browseDirectoryRequestSort :: Maybe (BrowseDirectoryRequestSort), browseDirectoryRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseDirectoryRequest where
  parseJSON = checked "BrowseDirectoryRequest" $ withObject "BrowseDirectoryRequest" (\fields -> BrowseDirectoryRequest <$> fields .: "path" <*> optional fields "sort" <*> traverse parseJSON (withoutFields ["path", "sort"] fields))
instance ToJSON BrowseDirectoryRequest where toJSON value = Object (KM.fromList (concat [[("path", toJSON (browseDirectoryRequestPath value))], optionalPair "sort" (browseDirectoryRequestSort value)]) <> fmap toJSON (withoutFields ["path", "sort"] (browseDirectoryRequestAdditionalProperties value)))

data BrowseDirectoryRequestSort = BrowseDirectoryRequestSortName | BrowseDirectoryRequestSortMtime | BrowseDirectoryRequestSortAnnotationCount deriving (Eq, Show)
instance FromJSON BrowseDirectoryRequestSort where
  parseJSON = checked "BrowseDirectoryRequestSort" $ \value -> if value == (String "name") then pure BrowseDirectoryRequestSortName else if value == (String "mtime") then pure BrowseDirectoryRequestSortMtime else if value == (String "annotationCount") then pure BrowseDirectoryRequestSortAnnotationCount else fail "unknown enumeration member"
instance ToJSON BrowseDirectoryRequestSort where
  toJSON BrowseDirectoryRequestSortName = String "name"
  toJSON BrowseDirectoryRequestSortMtime = String "mtime"
  toJSON BrowseDirectoryRequestSortAnnotationCount = String "annotationCount"
