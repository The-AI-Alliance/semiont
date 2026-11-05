-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.YieldCloneCreateCommand
  ( YieldCloneCreateCommand(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.ContentFormat
import Semiont.Internal.Generated.Models.UserId
data YieldCloneCreateCommand = YieldCloneCreateCommand { yieldCloneCreateCommandU5f_userId :: Maybe (UserId), yieldCloneCreateCommandArchiveOriginal :: Maybe (Bool), yieldCloneCreateCommandByteSize :: Integer, yieldCloneCreateCommandContentChecksum :: Text, yieldCloneCreateCommandFormat :: ContentFormat, yieldCloneCreateCommandName :: Text, yieldCloneCreateCommandStorageUri :: Text, yieldCloneCreateCommandToken :: Text, yieldCloneCreateCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON YieldCloneCreateCommand where
  parseJSON = checked "YieldCloneCreateCommand" $ withObject "YieldCloneCreateCommand" (\fields -> YieldCloneCreateCommand <$> optional fields "_userId" <*> optional fields "archiveOriginal" <*> fields .: "byteSize" <*> fields .: "contentChecksum" <*> fields .: "format" <*> fields .: "name" <*> fields .: "storageUri" <*> fields .: "token" <*> traverse parseJSON (withoutFields ["_userId", "archiveOriginal", "byteSize", "contentChecksum", "format", "name", "storageUri", "token"] fields))
instance ToJSON YieldCloneCreateCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (yieldCloneCreateCommandU5f_userId value), optionalPair "archiveOriginal" (yieldCloneCreateCommandArchiveOriginal value), [("byteSize", toJSON (yieldCloneCreateCommandByteSize value))], [("contentChecksum", toJSON (yieldCloneCreateCommandContentChecksum value))], [("format", toJSON (yieldCloneCreateCommandFormat value))], [("name", toJSON (yieldCloneCreateCommandName value))], [("storageUri", toJSON (yieldCloneCreateCommandStorageUri value))], [("token", toJSON (yieldCloneCreateCommandToken value))]]) <> fmap toJSON (withoutFields ["_userId", "archiveOriginal", "byteSize", "contentChecksum", "format", "name", "storageUri", "token"] (yieldCloneCreateCommandAdditionalProperties value)))

