-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ResourceUploadMetadata
  ( ResourceUploadMetadata(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnnotationId
import Semiont.Internal.Generated.Models.JobId
import Semiont.Internal.Generated.Models.ResourceId
data ResourceUploadMetadata = ResourceUploadMetadata { resourceUploadMetadataArchiveOriginal :: Maybe (Text), resourceUploadMetadataCloneToken :: Maybe (Text), resourceUploadMetadataEntityTypes :: Maybe (Text), resourceUploadMetadataFormat :: Text, resourceUploadMetadataGenerationPrompt :: Maybe (Text), resourceUploadMetadataGenerator :: Maybe (Text), resourceUploadMetadataIsDraft :: Maybe (Text), resourceUploadMetadataJobId :: Maybe (JobId), resourceUploadMetadataLanguage :: Maybe (Text), resourceUploadMetadataName :: Text, resourceUploadMetadataSourceAnnotationId :: Maybe (AnnotationId), resourceUploadMetadataSourceResourceId :: Maybe (ResourceId), resourceUploadMetadataStorageUri :: Text, resourceUploadMetadataAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ResourceUploadMetadata where
  parseJSON = checked "ResourceUploadMetadata" $ withObject "ResourceUploadMetadata" (\fields -> ResourceUploadMetadata <$> optional fields "archiveOriginal" <*> optional fields "cloneToken" <*> optional fields "entityTypes" <*> fields .: "format" <*> optional fields "generationPrompt" <*> optional fields "generator" <*> optional fields "isDraft" <*> optional fields "jobId" <*> optional fields "language" <*> fields .: "name" <*> optional fields "sourceAnnotationId" <*> optional fields "sourceResourceId" <*> fields .: "storageUri" <*> traverse parseJSON (withoutFields ["archiveOriginal", "cloneToken", "entityTypes", "format", "generationPrompt", "generator", "isDraft", "jobId", "language", "name", "sourceAnnotationId", "sourceResourceId", "storageUri"] fields))
instance ToJSON ResourceUploadMetadata where toJSON value = Object (KM.fromList (concat [optionalPair "archiveOriginal" (resourceUploadMetadataArchiveOriginal value), optionalPair "cloneToken" (resourceUploadMetadataCloneToken value), optionalPair "entityTypes" (resourceUploadMetadataEntityTypes value), [("format", toJSON (resourceUploadMetadataFormat value))], optionalPair "generationPrompt" (resourceUploadMetadataGenerationPrompt value), optionalPair "generator" (resourceUploadMetadataGenerator value), optionalPair "isDraft" (resourceUploadMetadataIsDraft value), optionalPair "jobId" (resourceUploadMetadataJobId value), optionalPair "language" (resourceUploadMetadataLanguage value), [("name", toJSON (resourceUploadMetadataName value))], optionalPair "sourceAnnotationId" (resourceUploadMetadataSourceAnnotationId value), optionalPair "sourceResourceId" (resourceUploadMetadataSourceResourceId value), [("storageUri", toJSON (resourceUploadMetadataStorageUri value))]]) <> fmap toJSON (withoutFields ["archiveOriginal", "cloneToken", "entityTypes", "format", "generationPrompt", "generator", "isDraft", "jobId", "language", "name", "sourceAnnotationId", "sourceResourceId", "storageUri"] (resourceUploadMetadataAdditionalProperties value)))
