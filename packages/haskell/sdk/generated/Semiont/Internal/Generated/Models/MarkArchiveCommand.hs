-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MarkArchiveCommand
  ( MarkArchiveCommand(..)
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
import Semiont.Internal.Generated.Models.UserId
data MarkArchiveCommand = MarkArchiveCommand { markArchiveCommandU5f_userId :: Maybe (UserId), markArchiveCommandKeepFile :: Maybe (Bool), markArchiveCommandResourceId :: ResourceId, markArchiveCommandStorageUri :: Maybe (Text), markArchiveCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MarkArchiveCommand where
  parseJSON = checked "MarkArchiveCommand" $ withObject "MarkArchiveCommand" (\fields -> MarkArchiveCommand <$> optional fields "_userId" <*> optional fields "keepFile" <*> fields .: "resourceId" <*> optional fields "storageUri" <*> traverse parseJSON (withoutFields ["_userId", "keepFile", "resourceId", "storageUri"] fields))
instance ToJSON MarkArchiveCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (markArchiveCommandU5f_userId value), optionalPair "keepFile" (markArchiveCommandKeepFile value), [("resourceId", toJSON (markArchiveCommandResourceId value))], optionalPair "storageUri" (markArchiveCommandStorageUri value)]) <> fmap toJSON (withoutFields ["_userId", "keepFile", "resourceId", "storageUri"] (markArchiveCommandAdditionalProperties value)))
