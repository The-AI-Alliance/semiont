-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GetAnnotationResponse
  ( GetAnnotationResponse(..)
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
import Semiont.Internal.Generated.Models.ResourceDescriptor
data GetAnnotationResponse = GetAnnotationResponse { getAnnotationResponseAnnotation :: Annotation, getAnnotationResponseResolvedResource :: Maybe (ResourceDescriptor), getAnnotationResponseResource :: Maybe (ResourceDescriptor), getAnnotationResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GetAnnotationResponse where
  parseJSON = checked "GetAnnotationResponse" $ withObject "GetAnnotationResponse" (\fields -> GetAnnotationResponse <$> fields .: "annotation" <*> fields .: "resolvedResource" <*> fields .: "resource" <*> traverse parseJSON (withoutFields ["annotation", "resolvedResource", "resource"] fields))
instance ToJSON GetAnnotationResponse where toJSON value = Object (KM.fromList (concat [[("annotation", toJSON (getAnnotationResponseAnnotation value))], [("resolvedResource", toJSON (getAnnotationResponseResolvedResource value))], [("resource", toJSON (getAnnotationResponseResource value))]]) <> fmap toJSON (withoutFields ["annotation", "resolvedResource", "resource"] (getAnnotationResponseAdditionalProperties value)))

