-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnnotationBodyUpdatedPayload
  ( AnnotationBodyUpdatedPayload(..)
  , AnnotationBodyUpdatedPayloadOperationsItem(..)
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
import Semiont.Internal.Generated.Models.BodyOperationAdd
import Semiont.Internal.Generated.Models.BodyOperationRemove
import Semiont.Internal.Generated.Models.BodyOperationReplace
data AnnotationBodyUpdatedPayload = AnnotationBodyUpdatedPayload { annotationBodyUpdatedPayloadAnnotationId :: AnnotationId, annotationBodyUpdatedPayloadOperations :: [AnnotationBodyUpdatedPayloadOperationsItem], annotationBodyUpdatedPayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON AnnotationBodyUpdatedPayload where
  parseJSON = checked "AnnotationBodyUpdatedPayload" $ withObject "AnnotationBodyUpdatedPayload" (\fields -> AnnotationBodyUpdatedPayload <$> fields .: "annotationId" <*> fields .: "operations" <*> traverse parseJSON (withoutFields ["annotationId", "operations"] fields))
instance ToJSON AnnotationBodyUpdatedPayload where toJSON value = Object (KM.fromList (concat [[("annotationId", toJSON (annotationBodyUpdatedPayloadAnnotationId value))], [("operations", toJSON (annotationBodyUpdatedPayloadOperations value))]]) <> fmap toJSON (withoutFields ["annotationId", "operations"] (annotationBodyUpdatedPayloadAdditionalProperties value)))

data AnnotationBodyUpdatedPayloadOperationsItem = AnnotationBodyUpdatedPayloadOperationsItemBranch1 (BodyOperationAdd) | AnnotationBodyUpdatedPayloadOperationsItemBranch2 (BodyOperationRemove) | AnnotationBodyUpdatedPayloadOperationsItemBranch3 (BodyOperationReplace) deriving (Eq, Show)
instance FromJSON AnnotationBodyUpdatedPayloadOperationsItem where
  parseJSON = checked "AnnotationBodyUpdatedPayloadOperationsItem" $ \value -> (AnnotationBodyUpdatedPayloadOperationsItemBranch1 <$> parseJSON value) <|> (AnnotationBodyUpdatedPayloadOperationsItemBranch2 <$> parseJSON value) <|> (AnnotationBodyUpdatedPayloadOperationsItemBranch3 <$> parseJSON value)
instance ToJSON AnnotationBodyUpdatedPayloadOperationsItem where
  toJSON (AnnotationBodyUpdatedPayloadOperationsItemBranch1 value) = toJSON value
  toJSON (AnnotationBodyUpdatedPayloadOperationsItemBranch2 value) = toJSON value
  toJSON (AnnotationBodyUpdatedPayloadOperationsItemBranch3 value) = toJSON value
