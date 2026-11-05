-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ContextualSummaryResponse
  ( ContextualSummaryResponse(..)
  , ContextualSummaryResponseContext(..)
  , ContextualSummaryResponseRelevantFields(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.ResourceId
data ContextualSummaryResponse = ContextualSummaryResponse { contextualSummaryResponseContext :: ContextualSummaryResponseContext, contextualSummaryResponseRelevantFields :: ContextualSummaryResponseRelevantFields, contextualSummaryResponseSummary :: Text, contextualSummaryResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ContextualSummaryResponse where
  parseJSON = checked "ContextualSummaryResponse" $ withObject "ContextualSummaryResponse" (\fields -> ContextualSummaryResponse <$> fields .: "context" <*> fields .: "relevantFields" <*> fields .: "summary" <*> traverse parseJSON (withoutFields ["context", "relevantFields", "summary"] fields))
instance ToJSON ContextualSummaryResponse where toJSON value = Object (KM.fromList (concat [[("context", toJSON (contextualSummaryResponseContext value))], [("relevantFields", toJSON (contextualSummaryResponseRelevantFields value))], [("summary", toJSON (contextualSummaryResponseSummary value))]]) <> fmap toJSON (withoutFields ["context", "relevantFields", "summary"] (contextualSummaryResponseAdditionalProperties value)))

data ContextualSummaryResponseContext = ContextualSummaryResponseContext { contextualSummaryResponseContextAfter :: Maybe (Text), contextualSummaryResponseContextBefore :: Maybe (Text), contextualSummaryResponseContextSelected :: Text, contextualSummaryResponseContextAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ContextualSummaryResponseContext where
  parseJSON = checked "ContextualSummaryResponseContext" $ withObject "ContextualSummaryResponseContext" (\fields -> ContextualSummaryResponseContext <$> optional fields "after" <*> optional fields "before" <*> fields .: "selected" <*> traverse parseJSON (withoutFields ["after", "before", "selected"] fields))
instance ToJSON ContextualSummaryResponseContext where toJSON value = Object (KM.fromList (concat [optionalPair "after" (contextualSummaryResponseContextAfter value), optionalPair "before" (contextualSummaryResponseContextBefore value), [("selected", toJSON (contextualSummaryResponseContextSelected value))]]) <> fmap toJSON (withoutFields ["after", "before", "selected"] (contextualSummaryResponseContextAdditionalProperties value)))

data ContextualSummaryResponseRelevantFields = ContextualSummaryResponseRelevantFields { contextualSummaryResponseRelevantFieldsEntityTypes :: [Text], contextualSummaryResponseRelevantFieldsResourceId :: ResourceId, contextualSummaryResponseRelevantFieldsResourceName :: Text } deriving (Eq, Show)
instance FromJSON ContextualSummaryResponseRelevantFields where
  parseJSON = checked "ContextualSummaryResponseRelevantFields" $ withObject "ContextualSummaryResponseRelevantFields" (\fields -> ContextualSummaryResponseRelevantFields <$> fields .: "entityTypes" <*> fields .: "resourceId" <*> fields .: "resourceName")
instance ToJSON ContextualSummaryResponseRelevantFields where toJSON value = Object (KM.fromList (concat [[("entityTypes", toJSON (contextualSummaryResponseRelevantFieldsEntityTypes value))], [("resourceId", toJSON (contextualSummaryResponseRelevantFieldsResourceId value))], [("resourceName", toJSON (contextualSummaryResponseRelevantFieldsResourceName value))]]))

