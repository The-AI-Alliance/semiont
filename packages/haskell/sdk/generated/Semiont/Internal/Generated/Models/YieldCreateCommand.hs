-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.YieldCreateCommand
  ( YieldCreateCommand(..)
  , YieldCreateCommandGeneratedFrom(..)
  , YieldCreateCommandGenerator(..)
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
import Semiont.Internal.Generated.Models.UserId
data YieldCreateCommand = YieldCreateCommand { yieldCreateCommandU5f_roles :: Maybe ([Text]), yieldCreateCommandU5f_userId :: Maybe (UserId), yieldCreateCommandByteSize :: Integer, yieldCreateCommandContentChecksum :: Text, yieldCreateCommandEntityTypes :: Maybe ([Text]), yieldCreateCommandFormat :: ContentFormat, yieldCreateCommandGeneratedFrom :: Maybe (YieldCreateCommandGeneratedFrom), yieldCreateCommandGenerationPrompt :: Maybe (Text), yieldCreateCommandGenerator :: Maybe (YieldCreateCommandGenerator), yieldCreateCommandIsDraft :: Maybe (Bool), yieldCreateCommandJobId :: Maybe (JobId), yieldCreateCommandLanguage :: Maybe (Text), yieldCreateCommandName :: Text, yieldCreateCommandStorageUri :: Text, yieldCreateCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON YieldCreateCommand where
  parseJSON = checked "YieldCreateCommand" $ withObject "YieldCreateCommand" (\fields -> YieldCreateCommand <$> optional fields "_roles" <*> optional fields "_userId" <*> fields .: "byteSize" <*> fields .: "contentChecksum" <*> optional fields "entityTypes" <*> fields .: "format" <*> optional fields "generatedFrom" <*> optional fields "generationPrompt" <*> optional fields "generator" <*> optional fields "isDraft" <*> optional fields "jobId" <*> optional fields "language" <*> fields .: "name" <*> fields .: "storageUri" <*> traverse parseJSON (withoutFields ["_roles", "_userId", "byteSize", "contentChecksum", "entityTypes", "format", "generatedFrom", "generationPrompt", "generator", "isDraft", "jobId", "language", "name", "storageUri"] fields))
instance ToJSON YieldCreateCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_roles" (yieldCreateCommandU5f_roles value), optionalPair "_userId" (yieldCreateCommandU5f_userId value), [("byteSize", toJSON (yieldCreateCommandByteSize value))], [("contentChecksum", toJSON (yieldCreateCommandContentChecksum value))], optionalPair "entityTypes" (yieldCreateCommandEntityTypes value), [("format", toJSON (yieldCreateCommandFormat value))], optionalPair "generatedFrom" (yieldCreateCommandGeneratedFrom value), optionalPair "generationPrompt" (yieldCreateCommandGenerationPrompt value), optionalPair "generator" (yieldCreateCommandGenerator value), optionalPair "isDraft" (yieldCreateCommandIsDraft value), optionalPair "jobId" (yieldCreateCommandJobId value), optionalPair "language" (yieldCreateCommandLanguage value), [("name", toJSON (yieldCreateCommandName value))], [("storageUri", toJSON (yieldCreateCommandStorageUri value))]]) <> fmap toJSON (withoutFields ["_roles", "_userId", "byteSize", "contentChecksum", "entityTypes", "format", "generatedFrom", "generationPrompt", "generator", "isDraft", "jobId", "language", "name", "storageUri"] (yieldCreateCommandAdditionalProperties value)))

data YieldCreateCommandGeneratedFrom = YieldCreateCommandGeneratedFrom { yieldCreateCommandGeneratedFromAnnotationId :: Maybe (AnnotationId), yieldCreateCommandGeneratedFromResourceId :: Maybe (ResourceId), yieldCreateCommandGeneratedFromAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON YieldCreateCommandGeneratedFrom where
  parseJSON = checked "YieldCreateCommandGeneratedFrom" $ withObject "YieldCreateCommandGeneratedFrom" (\fields -> YieldCreateCommandGeneratedFrom <$> optional fields "annotationId" <*> optional fields "resourceId" <*> traverse parseJSON (withoutFields ["annotationId", "resourceId"] fields))
instance ToJSON YieldCreateCommandGeneratedFrom where toJSON value = Object (KM.fromList (concat [optionalPair "annotationId" (yieldCreateCommandGeneratedFromAnnotationId value), optionalPair "resourceId" (yieldCreateCommandGeneratedFromResourceId value)]) <> fmap toJSON (withoutFields ["annotationId", "resourceId"] (yieldCreateCommandGeneratedFromAdditionalProperties value)))

data YieldCreateCommandGenerator = YieldCreateCommandGeneratorBranch1 (Agent) | YieldCreateCommandGeneratorBranch2 ([Agent]) deriving (Eq, Show)
instance FromJSON YieldCreateCommandGenerator where
  parseJSON = checked "YieldCreateCommandGenerator" $ \value -> (YieldCreateCommandGeneratorBranch1 <$> parseJSON value) <|> (YieldCreateCommandGeneratorBranch2 <$> parseJSON value)
instance ToJSON YieldCreateCommandGenerator where
  toJSON (YieldCreateCommandGeneratorBranch1 value) = toJSON value
  toJSON (YieldCreateCommandGeneratorBranch2 value) = toJSON value
