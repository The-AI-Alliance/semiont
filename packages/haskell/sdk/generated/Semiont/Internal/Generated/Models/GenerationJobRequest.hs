-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GenerationJobRequest
  ( GenerationJobRequest(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.SupportedMediaType
data GenerationJobRequest = GenerationJobRequest { generationJobRequestCite :: Maybe (Bool), generationJobRequestEntityTypes :: Maybe ([Text]), generationJobRequestLanguage :: Maybe (Text), generationJobRequestMaxTokens :: Maybe (Scientific), generationJobRequestOutputMediaType :: Maybe (SupportedMediaType), generationJobRequestPrompt :: Maybe (Text), generationJobRequestSourceLanguage :: Maybe (Text), generationJobRequestStorageUri :: Text, generationJobRequestStructure :: Maybe (Text), generationJobRequestTask :: Maybe (Text), generationJobRequestTemperature :: Maybe (Scientific), generationJobRequestTitle :: Text, generationJobRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GenerationJobRequest where
  parseJSON = checked "GenerationJobRequest" $ withObject "GenerationJobRequest" (\fields -> GenerationJobRequest <$> optional fields "cite" <*> optional fields "entityTypes" <*> optional fields "language" <*> optional fields "maxTokens" <*> optional fields "outputMediaType" <*> optional fields "prompt" <*> optional fields "sourceLanguage" <*> fields .: "storageUri" <*> optional fields "structure" <*> optional fields "task" <*> optional fields "temperature" <*> fields .: "title" <*> traverse parseJSON (withoutFields ["cite", "entityTypes", "language", "maxTokens", "outputMediaType", "prompt", "sourceLanguage", "storageUri", "structure", "task", "temperature", "title"] fields))
instance ToJSON GenerationJobRequest where toJSON value = Object (KM.fromList (concat [optionalPair "cite" (generationJobRequestCite value), optionalPair "entityTypes" (generationJobRequestEntityTypes value), optionalPair "language" (generationJobRequestLanguage value), optionalPair "maxTokens" (generationJobRequestMaxTokens value), optionalPair "outputMediaType" (generationJobRequestOutputMediaType value), optionalPair "prompt" (generationJobRequestPrompt value), optionalPair "sourceLanguage" (generationJobRequestSourceLanguage value), [("storageUri", toJSON (generationJobRequestStorageUri value))], optionalPair "structure" (generationJobRequestStructure value), optionalPair "task" (generationJobRequestTask value), optionalPair "temperature" (generationJobRequestTemperature value), [("title", toJSON (generationJobRequestTitle value))]]) <> fmap toJSON (withoutFields ["cite", "entityTypes", "language", "maxTokens", "outputMediaType", "prompt", "sourceLanguage", "storageUri", "structure", "task", "temperature", "title"] (generationJobRequestAdditionalProperties value)))

