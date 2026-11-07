-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.StoredEventResponse
  ( StoredEventResponse(..)
  , StoredEventResponsePayload(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.EventMetadata
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data StoredEventResponse = StoredEventResponse { storedEventResponseId :: Text, storedEventResponseMetadata :: EventMetadata, storedEventResponsePayload :: StoredEventResponsePayload, storedEventResponseResourceId :: Maybe (ResourceId), storedEventResponseTimestamp :: Text, storedEventResponseType :: Text, storedEventResponseUserId :: UserId, storedEventResponseVersion :: Integer, storedEventResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON StoredEventResponse where
  parseJSON = checked "StoredEventResponse" $ withObject "StoredEventResponse" (\fields -> StoredEventResponse <$> fields .: "id" <*> fields .: "metadata" <*> fields .: "payload" <*> optional fields "resourceId" <*> fields .: "timestamp" <*> fields .: "type" <*> fields .: "userId" <*> fields .: "version" <*> traverse parseJSON (withoutFields ["id", "metadata", "payload", "resourceId", "timestamp", "type", "userId", "version"] fields))
instance ToJSON StoredEventResponse where toJSON value = Object (KM.fromList (concat [[("id", toJSON (storedEventResponseId value))], [("metadata", toJSON (storedEventResponseMetadata value))], [("payload", toJSON (storedEventResponsePayload value))], optionalPair "resourceId" (storedEventResponseResourceId value), [("timestamp", toJSON (storedEventResponseTimestamp value))], [("type", toJSON (storedEventResponseType value))], [("userId", toJSON (storedEventResponseUserId value))], [("version", toJSON (storedEventResponseVersion value))]]) <> fmap toJSON (withoutFields ["id", "metadata", "payload", "resourceId", "timestamp", "type", "userId", "version"] (storedEventResponseAdditionalProperties value)))

data StoredEventResponsePayload = StoredEventResponsePayload { storedEventResponsePayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON StoredEventResponsePayload where
  parseJSON = checked "StoredEventResponsePayload" $ withObject "StoredEventResponsePayload" (\fields -> StoredEventResponsePayload <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON StoredEventResponsePayload where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (storedEventResponsePayloadAdditionalProperties value)))
