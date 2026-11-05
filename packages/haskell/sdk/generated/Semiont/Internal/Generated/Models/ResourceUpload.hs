-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ResourceUpload
  ( ResourceUpload(..)
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
data ResourceUpload = ResourceUpload { resourceUploadArchiveOriginal :: Maybe (Text), resourceUploadCloneToken :: Maybe (Text), resourceUploadEntityTypes :: Maybe (Text), resourceUploadFile :: Text, resourceUploadFormat :: Text, resourceUploadGenerationPrompt :: Maybe (Text), resourceUploadGenerator :: Maybe (Text), resourceUploadIsDraft :: Maybe (Text), resourceUploadJobId :: Maybe (JobId), resourceUploadLanguage :: Maybe (Text), resourceUploadName :: Text, resourceUploadSourceAnnotationId :: Maybe (AnnotationId), resourceUploadSourceResourceId :: Maybe (ResourceId), resourceUploadStorageUri :: Text, resourceUploadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ResourceUpload where
  parseJSON = checked "ResourceUpload" $ withObject "ResourceUpload" (\fields -> ResourceUpload <$> optional fields "archiveOriginal" <*> optional fields "cloneToken" <*> optional fields "entityTypes" <*> fields .: "file" <*> fields .: "format" <*> optional fields "generationPrompt" <*> optional fields "generator" <*> optional fields "isDraft" <*> optional fields "jobId" <*> optional fields "language" <*> fields .: "name" <*> optional fields "sourceAnnotationId" <*> optional fields "sourceResourceId" <*> fields .: "storageUri" <*> traverse parseJSON (withoutFields ["archiveOriginal", "cloneToken", "entityTypes", "file", "format", "generationPrompt", "generator", "isDraft", "jobId", "language", "name", "sourceAnnotationId", "sourceResourceId", "storageUri"] fields))
instance ToJSON ResourceUpload where toJSON value = Object (KM.fromList (concat [optionalPair "archiveOriginal" (resourceUploadArchiveOriginal value), optionalPair "cloneToken" (resourceUploadCloneToken value), optionalPair "entityTypes" (resourceUploadEntityTypes value), [("file", toJSON (resourceUploadFile value))], [("format", toJSON (resourceUploadFormat value))], optionalPair "generationPrompt" (resourceUploadGenerationPrompt value), optionalPair "generator" (resourceUploadGenerator value), optionalPair "isDraft" (resourceUploadIsDraft value), optionalPair "jobId" (resourceUploadJobId value), optionalPair "language" (resourceUploadLanguage value), [("name", toJSON (resourceUploadName value))], optionalPair "sourceAnnotationId" (resourceUploadSourceAnnotationId value), optionalPair "sourceResourceId" (resourceUploadSourceResourceId value), [("storageUri", toJSON (resourceUploadStorageUri value))]]) <> fmap toJSON (withoutFields ["archiveOriginal", "cloneToken", "entityTypes", "file", "format", "generationPrompt", "generator", "isDraft", "jobId", "language", "name", "sourceAnnotationId", "sourceResourceId", "storageUri"] (resourceUploadAdditionalProperties value)))

