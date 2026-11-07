-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ResourceClonedPayload
  ( ResourceClonedPayload(..)
  , ResourceClonedPayloadWasAttributedTo(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Agent
import Semiont.Internal.Generated.Models.ContentFormat
import Semiont.Internal.Generated.Models.ResourceId
data ResourceClonedPayload = ResourceClonedPayload { resourceClonedPayloadContentByteSize :: Maybe (Integer), resourceClonedPayloadContentChecksum :: Text, resourceClonedPayloadCreator :: Maybe (Agent), resourceClonedPayloadEntityTypes :: Maybe ([Text]), resourceClonedPayloadFormat :: ContentFormat, resourceClonedPayloadLanguage :: Maybe (Text), resourceClonedPayloadName :: Text, resourceClonedPayloadParentResourceId :: ResourceId, resourceClonedPayloadStorageUri :: Maybe (Text), resourceClonedPayloadWasAttributedTo :: Maybe (ResourceClonedPayloadWasAttributedTo), resourceClonedPayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ResourceClonedPayload where
  parseJSON = checked "ResourceClonedPayload" $ withObject "ResourceClonedPayload" (\fields -> ResourceClonedPayload <$> optional fields "contentByteSize" <*> fields .: "contentChecksum" <*> optional fields "creator" <*> optional fields "entityTypes" <*> fields .: "format" <*> optional fields "language" <*> fields .: "name" <*> fields .: "parentResourceId" <*> optional fields "storageUri" <*> optional fields "wasAttributedTo" <*> traverse parseJSON (withoutFields ["contentByteSize", "contentChecksum", "creator", "entityTypes", "format", "language", "name", "parentResourceId", "storageUri", "wasAttributedTo"] fields))
instance ToJSON ResourceClonedPayload where toJSON value = Object (KM.fromList (concat [optionalPair "contentByteSize" (resourceClonedPayloadContentByteSize value), [("contentChecksum", toJSON (resourceClonedPayloadContentChecksum value))], optionalPair "creator" (resourceClonedPayloadCreator value), optionalPair "entityTypes" (resourceClonedPayloadEntityTypes value), [("format", toJSON (resourceClonedPayloadFormat value))], optionalPair "language" (resourceClonedPayloadLanguage value), [("name", toJSON (resourceClonedPayloadName value))], [("parentResourceId", toJSON (resourceClonedPayloadParentResourceId value))], optionalPair "storageUri" (resourceClonedPayloadStorageUri value), optionalPair "wasAttributedTo" (resourceClonedPayloadWasAttributedTo value)]) <> fmap toJSON (withoutFields ["contentByteSize", "contentChecksum", "creator", "entityTypes", "format", "language", "name", "parentResourceId", "storageUri", "wasAttributedTo"] (resourceClonedPayloadAdditionalProperties value)))

data ResourceClonedPayloadWasAttributedTo = ResourceClonedPayloadWasAttributedToBranch1 (Agent) | ResourceClonedPayloadWasAttributedToBranch2 ([Agent]) deriving (Eq, Show)
instance FromJSON ResourceClonedPayloadWasAttributedTo where
  parseJSON = checked "ResourceClonedPayloadWasAttributedTo" $ \value -> (ResourceClonedPayloadWasAttributedToBranch1 <$> parseJSON value) <|> (ResourceClonedPayloadWasAttributedToBranch2 <$> parseJSON value)
instance ToJSON ResourceClonedPayloadWasAttributedTo where
  toJSON (ResourceClonedPayloadWasAttributedToBranch1 value) = toJSON value
  toJSON (ResourceClonedPayloadWasAttributedToBranch2 value) = toJSON value
