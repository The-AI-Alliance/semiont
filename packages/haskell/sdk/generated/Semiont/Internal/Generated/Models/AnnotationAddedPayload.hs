-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnnotationAddedPayload
  ( AnnotationAddedPayload(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Annotation
data AnnotationAddedPayload = AnnotationAddedPayload { annotationAddedPayloadAnnotation :: Annotation, annotationAddedPayloadContentChecksum :: Maybe (Text), annotationAddedPayloadAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON AnnotationAddedPayload where
  parseJSON = checked "AnnotationAddedPayload" $ withObject "AnnotationAddedPayload" (\fields -> AnnotationAddedPayload <$> fields .: "annotation" <*> optional fields "contentChecksum" <*> traverse parseJSON (withoutFields ["annotation", "contentChecksum"] fields))
instance ToJSON AnnotationAddedPayload where toJSON value = Object (KM.fromList (concat [[("annotation", toJSON (annotationAddedPayloadAnnotation value))], optionalPair "contentChecksum" (annotationAddedPayloadContentChecksum value)]) <> fmap toJSON (withoutFields ["annotation", "contentChecksum"] (annotationAddedPayloadAdditionalProperties value)))
