-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobProgress
  ( JobProgress(..)
  , JobProgressCompletedItemsItem(..)
  , JobProgressCompletedItemsItemUnderReported(..)
  , JobProgressCurrent(..)
  , JobProgressCurrentKind(..)
  , JobProgressRequestParamsItem(..)
  , JobProgressRequestParamsItemLabel(..)
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
import Semiont.Internal.Generated.Models.JobProgressMessage
data JobProgress = JobProgress { jobProgressAnnotationId :: Maybe (AnnotationId), jobProgressCompletedItems :: Maybe ([JobProgressCompletedItemsItem]), jobProgressCurrent :: Maybe (JobProgressCurrent), jobProgressEntitiesEmitted :: Maybe (Integer), jobProgressEntitiesExpected :: Maybe (Integer), jobProgressEntitiesFound :: Maybe (Integer), jobProgressMessage :: Maybe (JobProgressMessage), jobProgressPercentage :: Scientific, jobProgressProcessed :: Maybe (Integer), jobProgressRequestParams :: Maybe ([JobProgressRequestParamsItem]), jobProgressTotal :: Maybe (Integer), jobProgressAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobProgress where
  parseJSON = checked "JobProgress" $ withObject "JobProgress" (\fields -> JobProgress <$> optional fields "annotationId" <*> optional fields "completedItems" <*> optional fields "current" <*> optional fields "entitiesEmitted" <*> optional fields "entitiesExpected" <*> optional fields "entitiesFound" <*> optional fields "message" <*> fields .: "percentage" <*> optional fields "processed" <*> optional fields "requestParams" <*> optional fields "total" <*> traverse parseJSON (withoutFields ["annotationId", "completedItems", "current", "entitiesEmitted", "entitiesExpected", "entitiesFound", "message", "percentage", "processed", "requestParams", "total"] fields))
instance ToJSON JobProgress where toJSON value = Object (KM.fromList (concat [optionalPair "annotationId" (jobProgressAnnotationId value), optionalPair "completedItems" (jobProgressCompletedItems value), optionalPair "current" (jobProgressCurrent value), optionalPair "entitiesEmitted" (jobProgressEntitiesEmitted value), optionalPair "entitiesExpected" (jobProgressEntitiesExpected value), optionalPair "entitiesFound" (jobProgressEntitiesFound value), optionalPair "message" (jobProgressMessage value), [("percentage", toJSON (jobProgressPercentage value))], optionalPair "processed" (jobProgressProcessed value), optionalPair "requestParams" (jobProgressRequestParams value), optionalPair "total" (jobProgressTotal value)]) <> fmap toJSON (withoutFields ["annotationId", "completedItems", "current", "entitiesEmitted", "entitiesExpected", "entitiesFound", "message", "percentage", "processed", "requestParams", "total"] (jobProgressAdditionalProperties value)))

data JobProgressCompletedItemsItem = JobProgressCompletedItemsItem { jobProgressCompletedItemsItemFoundCount :: Integer, jobProgressCompletedItemsItemPersistedCount :: Maybe (Integer), jobProgressCompletedItemsItemUnderReported :: Maybe (JobProgressCompletedItemsItemUnderReported), jobProgressCompletedItemsItemValue :: Text, jobProgressCompletedItemsItemAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobProgressCompletedItemsItem where
  parseJSON = checked "JobProgressCompletedItemsItem" $ withObject "JobProgressCompletedItemsItem" (\fields -> JobProgressCompletedItemsItem <$> fields .: "foundCount" <*> optional fields "persistedCount" <*> optional fields "underReported" <*> fields .: "value" <*> traverse parseJSON (withoutFields ["foundCount", "persistedCount", "underReported", "value"] fields))
instance ToJSON JobProgressCompletedItemsItem where toJSON value = Object (KM.fromList (concat [[("foundCount", toJSON (jobProgressCompletedItemsItemFoundCount value))], optionalPair "persistedCount" (jobProgressCompletedItemsItemPersistedCount value), optionalPair "underReported" (jobProgressCompletedItemsItemUnderReported value), [("value", toJSON (jobProgressCompletedItemsItemValue value))]]) <> fmap toJSON (withoutFields ["foundCount", "persistedCount", "underReported", "value"] (jobProgressCompletedItemsItemAdditionalProperties value)))

data JobProgressCompletedItemsItemUnderReported = JobProgressCompletedItemsItemUnderReported { jobProgressCompletedItemsItemUnderReportedCounted :: Integer, jobProgressCompletedItemsItemUnderReportedFound :: Integer, jobProgressCompletedItemsItemUnderReportedPieces :: Integer, jobProgressCompletedItemsItemUnderReportedAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobProgressCompletedItemsItemUnderReported where
  parseJSON = checked "JobProgressCompletedItemsItemUnderReported" $ withObject "JobProgressCompletedItemsItemUnderReported" (\fields -> JobProgressCompletedItemsItemUnderReported <$> fields .: "counted" <*> fields .: "found" <*> fields .: "pieces" <*> traverse parseJSON (withoutFields ["counted", "found", "pieces"] fields))
instance ToJSON JobProgressCompletedItemsItemUnderReported where toJSON value = Object (KM.fromList (concat [[("counted", toJSON (jobProgressCompletedItemsItemUnderReportedCounted value))], [("found", toJSON (jobProgressCompletedItemsItemUnderReportedFound value))], [("pieces", toJSON (jobProgressCompletedItemsItemUnderReportedPieces value))]]) <> fmap toJSON (withoutFields ["counted", "found", "pieces"] (jobProgressCompletedItemsItemUnderReportedAdditionalProperties value)))

data JobProgressCurrent = JobProgressCurrent { jobProgressCurrentKind :: JobProgressCurrentKind, jobProgressCurrentValue :: Text, jobProgressCurrentAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobProgressCurrent where
  parseJSON = checked "JobProgressCurrent" $ withObject "JobProgressCurrent" (\fields -> JobProgressCurrent <$> fields .: "kind" <*> fields .: "value" <*> traverse parseJSON (withoutFields ["kind", "value"] fields))
instance ToJSON JobProgressCurrent where toJSON value = Object (KM.fromList (concat [[("kind", toJSON (jobProgressCurrentKind value))], [("value", toJSON (jobProgressCurrentValue value))]]) <> fmap toJSON (withoutFields ["kind", "value"] (jobProgressCurrentAdditionalProperties value)))

data JobProgressCurrentKind = JobProgressCurrentKindEntityU2d_type | JobProgressCurrentKindCategory deriving (Eq, Show)
instance FromJSON JobProgressCurrentKind where
  parseJSON = checked "JobProgressCurrentKind" $ \value -> if value == (String "entity-type") then pure JobProgressCurrentKindEntityU2d_type else if value == (String "category") then pure JobProgressCurrentKindCategory else fail "unknown enumeration member"
instance ToJSON JobProgressCurrentKind where
  toJSON JobProgressCurrentKindEntityU2d_type = String "entity-type"
  toJSON JobProgressCurrentKindCategory = String "category"


data JobProgressRequestParamsItem = JobProgressRequestParamsItem { jobProgressRequestParamsItemLabel :: JobProgressRequestParamsItemLabel, jobProgressRequestParamsItemValue :: Text, jobProgressRequestParamsItemAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobProgressRequestParamsItem where
  parseJSON = checked "JobProgressRequestParamsItem" $ withObject "JobProgressRequestParamsItem" (\fields -> JobProgressRequestParamsItem <$> fields .: "label" <*> fields .: "value" <*> traverse parseJSON (withoutFields ["label", "value"] fields))
instance ToJSON JobProgressRequestParamsItem where toJSON value = Object (KM.fromList (concat [[("label", toJSON (jobProgressRequestParamsItemLabel value))], [("value", toJSON (jobProgressRequestParamsItemValue value))]]) <> fmap toJSON (withoutFields ["label", "value"] (jobProgressRequestParamsItemAdditionalProperties value)))

data JobProgressRequestParamsItemLabel = JobProgressRequestParamsItemLabelEntityU2d_types | JobProgressRequestParamsItemLabelInstructions | JobProgressRequestParamsItemLabelTone | JobProgressRequestParamsItemLabelDensity deriving (Eq, Show)
instance FromJSON JobProgressRequestParamsItemLabel where
  parseJSON = checked "JobProgressRequestParamsItemLabel" $ \value -> if value == (String "entity-types") then pure JobProgressRequestParamsItemLabelEntityU2d_types else if value == (String "instructions") then pure JobProgressRequestParamsItemLabelInstructions else if value == (String "tone") then pure JobProgressRequestParamsItemLabelTone else if value == (String "density") then pure JobProgressRequestParamsItemLabelDensity else fail "unknown enumeration member"
instance ToJSON JobProgressRequestParamsItemLabel where
  toJSON JobProgressRequestParamsItemLabelEntityU2d_types = String "entity-types"
  toJSON JobProgressRequestParamsItemLabelInstructions = String "instructions"
  toJSON JobProgressRequestParamsItemLabelTone = String "tone"
  toJSON JobProgressRequestParamsItemLabelDensity = String "density"
