-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ResourceCreatedPayload
  ( ResourceCreatedPayload(..)
  , ResourceCreatedPayloadGeneratedFrom(..)
  , ResourceCreatedPayloadGenerator(..)
  , ResourceCreatedPayloadWasAttributedTo(..)
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
import Semiont.Internal.Generated.Models.AnnotationId
import Semiont.Internal.Generated.Models.ContentFormat
import Semiont.Internal.Generated.Models.JobId
import Semiont.Internal.Generated.Models.ResourceId
data ResourceCreatedPayload = ResourceCreatedPayload { resourceCreatedPayloadContentByteSize :: Maybe (Integer), resourceCreatedPayloadContentChecksum :: Text, resourceCreatedPayloadCreator :: Maybe (Agent), resourceCreatedPayloadEntityTypes :: Maybe ([Text]), resourceCreatedPayloadFormat :: ContentFormat, resourceCreatedPayloadGeneratedFrom :: Maybe (ResourceCreatedPayloadGeneratedFrom), resourceCreatedPayloadGenerationPrompt :: Maybe (Text), resourceCreatedPayloadGenerator :: Maybe (ResourceCreatedPayloadGenerator), resourceCreatedPayloadIsDraft :: Maybe (Bool), resourceCreatedPayloadJobId :: Maybe (JobId), resourceCreatedPayloadLanguage :: Maybe (Text), resourceCreatedPayloadName :: Text, resourceCreatedPayloadStorageUri :: Maybe (Text), resourceCreatedPayloadWasAttributedTo :: Maybe (ResourceCreatedPayloadWasAttributedTo), resourceCreatedPayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ResourceCreatedPayload where
  parseJSON = checked "ResourceCreatedPayload" $ withObject "ResourceCreatedPayload" (\fields -> ResourceCreatedPayload <$> optional fields "contentByteSize" <*> fields .: "contentChecksum" <*> optional fields "creator" <*> optional fields "entityTypes" <*> fields .: "format" <*> optional fields "generatedFrom" <*> optional fields "generationPrompt" <*> optional fields "generator" <*> optional fields "isDraft" <*> optional fields "jobId" <*> optional fields "language" <*> fields .: "name" <*> optional fields "storageUri" <*> optional fields "wasAttributedTo" <*> traverse parseJSON (withoutFields ["contentByteSize", "contentChecksum", "creator", "entityTypes", "format", "generatedFrom", "generationPrompt", "generator", "isDraft", "jobId", "language", "name", "storageUri", "wasAttributedTo"] fields))
instance ToJSON ResourceCreatedPayload where toJSON value = Object (KM.fromList (concat [optionalPair "contentByteSize" (resourceCreatedPayloadContentByteSize value), [("contentChecksum", toJSON (resourceCreatedPayloadContentChecksum value))], optionalPair "creator" (resourceCreatedPayloadCreator value), optionalPair "entityTypes" (resourceCreatedPayloadEntityTypes value), [("format", toJSON (resourceCreatedPayloadFormat value))], optionalPair "generatedFrom" (resourceCreatedPayloadGeneratedFrom value), optionalPair "generationPrompt" (resourceCreatedPayloadGenerationPrompt value), optionalPair "generator" (resourceCreatedPayloadGenerator value), optionalPair "isDraft" (resourceCreatedPayloadIsDraft value), optionalPair "jobId" (resourceCreatedPayloadJobId value), optionalPair "language" (resourceCreatedPayloadLanguage value), [("name", toJSON (resourceCreatedPayloadName value))], optionalPair "storageUri" (resourceCreatedPayloadStorageUri value), optionalPair "wasAttributedTo" (resourceCreatedPayloadWasAttributedTo value)]) <> fmap toJSON (withoutFields ["contentByteSize", "contentChecksum", "creator", "entityTypes", "format", "generatedFrom", "generationPrompt", "generator", "isDraft", "jobId", "language", "name", "storageUri", "wasAttributedTo"] (resourceCreatedPayloadAdditionalProperties value)))

data ResourceCreatedPayloadGeneratedFrom = ResourceCreatedPayloadGeneratedFrom { resourceCreatedPayloadGeneratedFromAnnotationId :: Maybe (AnnotationId), resourceCreatedPayloadGeneratedFromResourceId :: ResourceId, resourceCreatedPayloadGeneratedFromAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ResourceCreatedPayloadGeneratedFrom where
  parseJSON = checked "ResourceCreatedPayloadGeneratedFrom" $ withObject "ResourceCreatedPayloadGeneratedFrom" (\fields -> ResourceCreatedPayloadGeneratedFrom <$> optional fields "annotationId" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["annotationId", "resourceId"] fields))
instance ToJSON ResourceCreatedPayloadGeneratedFrom where toJSON value = Object (KM.fromList (concat [optionalPair "annotationId" (resourceCreatedPayloadGeneratedFromAnnotationId value), [("resourceId", toJSON (resourceCreatedPayloadGeneratedFromResourceId value))]]) <> fmap toJSON (withoutFields ["annotationId", "resourceId"] (resourceCreatedPayloadGeneratedFromAdditionalProperties value)))

data ResourceCreatedPayloadGenerator = ResourceCreatedPayloadGeneratorBranch1 (Agent) | ResourceCreatedPayloadGeneratorBranch2 ([Agent]) deriving (Eq, Show)
instance FromJSON ResourceCreatedPayloadGenerator where
  parseJSON = checked "ResourceCreatedPayloadGenerator" $ \value -> (ResourceCreatedPayloadGeneratorBranch1 <$> parseJSON value) <|> (ResourceCreatedPayloadGeneratorBranch2 <$> parseJSON value)
instance ToJSON ResourceCreatedPayloadGenerator where
  toJSON (ResourceCreatedPayloadGeneratorBranch1 value) = toJSON value
  toJSON (ResourceCreatedPayloadGeneratorBranch2 value) = toJSON value


data ResourceCreatedPayloadWasAttributedTo = ResourceCreatedPayloadWasAttributedToBranch1 (Agent) | ResourceCreatedPayloadWasAttributedToBranch2 ([Agent]) deriving (Eq, Show)
instance FromJSON ResourceCreatedPayloadWasAttributedTo where
  parseJSON = checked "ResourceCreatedPayloadWasAttributedTo" $ \value -> (ResourceCreatedPayloadWasAttributedToBranch1 <$> parseJSON value) <|> (ResourceCreatedPayloadWasAttributedToBranch2 <$> parseJSON value)
instance ToJSON ResourceCreatedPayloadWasAttributedTo where
  toJSON (ResourceCreatedPayloadWasAttributedToBranch1 value) = toJSON value
  toJSON (ResourceCreatedPayloadWasAttributedToBranch2 value) = toJSON value


