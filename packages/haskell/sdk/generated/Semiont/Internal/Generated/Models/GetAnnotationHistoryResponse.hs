-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GetAnnotationHistoryResponse
  ( GetAnnotationHistoryResponse(..)
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
import Semiont.Internal.Generated.Models.AttributedEvent
import Semiont.Internal.Generated.Models.ResourceId
data GetAnnotationHistoryResponse = GetAnnotationHistoryResponse { getAnnotationHistoryResponseAnnotationId :: AnnotationId, getAnnotationHistoryResponseEvents :: [AttributedEvent], getAnnotationHistoryResponseResourceId :: ResourceId, getAnnotationHistoryResponseTotal :: Scientific, getAnnotationHistoryResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GetAnnotationHistoryResponse where
  parseJSON = checked "GetAnnotationHistoryResponse" $ withObject "GetAnnotationHistoryResponse" (\fields -> GetAnnotationHistoryResponse <$> fields .: "annotationId" <*> fields .: "events" <*> fields .: "resourceId" <*> fields .: "total" <*> traverse parseJSON (withoutFields ["annotationId", "events", "resourceId", "total"] fields))
instance ToJSON GetAnnotationHistoryResponse where toJSON value = Object (KM.fromList (concat [[("annotationId", toJSON (getAnnotationHistoryResponseAnnotationId value))], [("events", toJSON (getAnnotationHistoryResponseEvents value))], [("resourceId", toJSON (getAnnotationHistoryResponseResourceId value))], [("total", toJSON (getAnnotationHistoryResponseTotal value))]]) <> fmap toJSON (withoutFields ["annotationId", "events", "resourceId", "total"] (getAnnotationHistoryResponseAdditionalProperties value)))
