-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AttributedEvent
  ( AttributedEvent(..)
  , AttributedEventPayload(..)
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
import Semiont.Internal.Generated.Models.EventMetadata
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data AttributedEvent = AttributedEvent { attributedEventAgent :: Agent, attributedEventId :: Text, attributedEventMetadata :: EventMetadata, attributedEventPayload :: AttributedEventPayload, attributedEventResourceId :: Maybe (ResourceId), attributedEventTimestamp :: Text, attributedEventType :: Text, attributedEventUserId :: UserId, attributedEventVersion :: Integer, attributedEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON AttributedEvent where
  parseJSON = checked "AttributedEvent" $ withObject "AttributedEvent" (\fields -> AttributedEvent <$> fields .: "agent" <*> fields .: "id" <*> fields .: "metadata" <*> fields .: "payload" <*> optional fields "resourceId" <*> fields .: "timestamp" <*> fields .: "type" <*> fields .: "userId" <*> fields .: "version" <*> traverse parseJSON (withoutFields ["agent", "id", "metadata", "payload", "resourceId", "timestamp", "type", "userId", "version"] fields))
instance ToJSON AttributedEvent where toJSON value = Object (KM.fromList (concat [[("agent", toJSON (attributedEventAgent value))], [("id", toJSON (attributedEventId value))], [("metadata", toJSON (attributedEventMetadata value))], [("payload", toJSON (attributedEventPayload value))], optionalPair "resourceId" (attributedEventResourceId value), [("timestamp", toJSON (attributedEventTimestamp value))], [("type", toJSON (attributedEventType value))], [("userId", toJSON (attributedEventUserId value))], [("version", toJSON (attributedEventVersion value))]]) <> fmap toJSON (withoutFields ["agent", "id", "metadata", "payload", "resourceId", "timestamp", "type", "userId", "version"] (attributedEventAdditionalProperties value)))

data AttributedEventPayload = AttributedEventPayload { attributedEventPayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON AttributedEventPayload where
  parseJSON = checked "AttributedEventPayload" $ withObject "AttributedEventPayload" (\fields -> AttributedEventPayload <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON AttributedEventPayload where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (attributedEventPayloadAdditionalProperties value)))

