-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.YieldClonePersistCommand
  ( YieldClonePersistCommand(..)
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
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data YieldClonePersistCommand = YieldClonePersistCommand { yieldClonePersistCommandU5f_userId :: Maybe (UserId), yieldClonePersistCommandByteSize :: Integer, yieldClonePersistCommandContentChecksum :: Text, yieldClonePersistCommandEntityTypes :: Maybe ([Text]), yieldClonePersistCommandFormat :: ContentFormat, yieldClonePersistCommandLanguage :: Maybe (Text), yieldClonePersistCommandName :: Text, yieldClonePersistCommandParentResourceId :: ResourceId, yieldClonePersistCommandStorageUri :: Text, yieldClonePersistCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON YieldClonePersistCommand where
  parseJSON = checked "YieldClonePersistCommand" $ withObject "YieldClonePersistCommand" (\fields -> YieldClonePersistCommand <$> optional fields "_userId" <*> fields .: "byteSize" <*> fields .: "contentChecksum" <*> optional fields "entityTypes" <*> fields .: "format" <*> optional fields "language" <*> fields .: "name" <*> fields .: "parentResourceId" <*> fields .: "storageUri" <*> traverse parseJSON (withoutFields ["_userId", "byteSize", "contentChecksum", "entityTypes", "format", "language", "name", "parentResourceId", "storageUri"] fields))
instance ToJSON YieldClonePersistCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (yieldClonePersistCommandU5f_userId value), [("byteSize", toJSON (yieldClonePersistCommandByteSize value))], [("contentChecksum", toJSON (yieldClonePersistCommandContentChecksum value))], optionalPair "entityTypes" (yieldClonePersistCommandEntityTypes value), [("format", toJSON (yieldClonePersistCommandFormat value))], optionalPair "language" (yieldClonePersistCommandLanguage value), [("name", toJSON (yieldClonePersistCommandName value))], [("parentResourceId", toJSON (yieldClonePersistCommandParentResourceId value))], [("storageUri", toJSON (yieldClonePersistCommandStorageUri value))]]) <> fmap toJSON (withoutFields ["_userId", "byteSize", "contentChecksum", "entityTypes", "format", "language", "name", "parentResourceId", "storageUri"] (yieldClonePersistCommandAdditionalProperties value)))
