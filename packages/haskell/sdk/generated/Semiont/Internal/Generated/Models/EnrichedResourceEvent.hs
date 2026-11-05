-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.EnrichedResourceEvent
  ( EnrichedResourceEvent(..)
  , EnrichedResourceEventPayload(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Annotation
import Semiont.Internal.Generated.Models.EventMetadata
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data EnrichedResourceEvent = EnrichedResourceEvent { enrichedResourceEventAnnotation :: Maybe (Annotation), enrichedResourceEventId :: Text, enrichedResourceEventMetadata :: EventMetadata, enrichedResourceEventPayload :: EnrichedResourceEventPayload, enrichedResourceEventResourceId :: Maybe (ResourceId), enrichedResourceEventTimestamp :: Text, enrichedResourceEventType :: Text, enrichedResourceEventUserId :: UserId, enrichedResourceEventVersion :: Integer, enrichedResourceEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON EnrichedResourceEvent where
  parseJSON = checked "EnrichedResourceEvent" $ withObject "EnrichedResourceEvent" (\fields -> EnrichedResourceEvent <$> optional fields "annotation" <*> fields .: "id" <*> fields .: "metadata" <*> fields .: "payload" <*> optional fields "resourceId" <*> fields .: "timestamp" <*> fields .: "type" <*> fields .: "userId" <*> fields .: "version" <*> traverse parseJSON (withoutFields ["annotation", "id", "metadata", "payload", "resourceId", "timestamp", "type", "userId", "version"] fields))
instance ToJSON EnrichedResourceEvent where toJSON value = Object (KM.fromList (concat [optionalPair "annotation" (enrichedResourceEventAnnotation value), [("id", toJSON (enrichedResourceEventId value))], [("metadata", toJSON (enrichedResourceEventMetadata value))], [("payload", toJSON (enrichedResourceEventPayload value))], optionalPair "resourceId" (enrichedResourceEventResourceId value), [("timestamp", toJSON (enrichedResourceEventTimestamp value))], [("type", toJSON (enrichedResourceEventType value))], [("userId", toJSON (enrichedResourceEventUserId value))], [("version", toJSON (enrichedResourceEventVersion value))]]) <> fmap toJSON (withoutFields ["annotation", "id", "metadata", "payload", "resourceId", "timestamp", "type", "userId", "version"] (enrichedResourceEventAdditionalProperties value)))

data EnrichedResourceEventPayload = EnrichedResourceEventPayload { enrichedResourceEventPayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON EnrichedResourceEventPayload where
  parseJSON = checked "EnrichedResourceEventPayload" $ withObject "EnrichedResourceEventPayload" (\fields -> EnrichedResourceEventPayload <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON EnrichedResourceEventPayload where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (enrichedResourceEventPayloadAdditionalProperties value)))

