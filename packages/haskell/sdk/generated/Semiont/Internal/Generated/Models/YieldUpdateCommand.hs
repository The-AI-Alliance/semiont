-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.YieldUpdateCommand
  ( YieldUpdateCommand(..)
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
data YieldUpdateCommand = YieldUpdateCommand { yieldUpdateCommandU5f_userId :: Maybe (UserId), yieldUpdateCommandByteSize :: Integer, yieldUpdateCommandContentChecksum :: Text, yieldUpdateCommandResourceId :: ResourceId, yieldUpdateCommandStorageUri :: Text, yieldUpdateCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON YieldUpdateCommand where
  parseJSON = checked "YieldUpdateCommand" $ withObject "YieldUpdateCommand" (\fields -> YieldUpdateCommand <$> optional fields "_userId" <*> fields .: "byteSize" <*> fields .: "contentChecksum" <*> fields .: "resourceId" <*> fields .: "storageUri" <*> traverse parseJSON (withoutFields ["_userId", "byteSize", "contentChecksum", "resourceId", "storageUri"] fields))
instance ToJSON YieldUpdateCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (yieldUpdateCommandU5f_userId value), [("byteSize", toJSON (yieldUpdateCommandByteSize value))], [("contentChecksum", toJSON (yieldUpdateCommandContentChecksum value))], [("resourceId", toJSON (yieldUpdateCommandResourceId value))], [("storageUri", toJSON (yieldUpdateCommandStorageUri value))]]) <> fmap toJSON (withoutFields ["_userId", "byteSize", "contentChecksum", "resourceId", "storageUri"] (yieldUpdateCommandAdditionalProperties value)))
