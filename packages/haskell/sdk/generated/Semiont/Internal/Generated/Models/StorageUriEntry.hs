-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.StorageUriEntry
  ( StorageUriEntry(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.ResourceId
data StorageUriEntry = StorageUriEntry { storageUriEntryResourceId :: ResourceId, storageUriEntryUri :: Text } deriving (Eq, Show)
instance FromJSON StorageUriEntry where
  parseJSON = checked "StorageUriEntry" $ withObject "StorageUriEntry" (\fields -> StorageUriEntry <$> fields .: "resourceId" <*> fields .: "uri")
instance ToJSON StorageUriEntry where toJSON value = Object (KM.fromList (concat [[("resourceId", toJSON (storageUriEntryResourceId value))], [("uri", toJSON (storageUriEntryUri value))]]))
