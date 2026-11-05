-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseAnnotationRequest
  ( BrowseAnnotationRequest(..)
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
import Semiont.Internal.Generated.Models.ResourceId
data BrowseAnnotationRequest = BrowseAnnotationRequest { browseAnnotationRequestAnnotationId :: AnnotationId, browseAnnotationRequestResourceId :: ResourceId, browseAnnotationRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseAnnotationRequest where
  parseJSON = checked "BrowseAnnotationRequest" $ withObject "BrowseAnnotationRequest" (\fields -> BrowseAnnotationRequest <$> fields .: "annotationId" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["annotationId", "resourceId"] fields))
instance ToJSON BrowseAnnotationRequest where toJSON value = Object (KM.fromList (concat [[("annotationId", toJSON (browseAnnotationRequestAnnotationId value))], [("resourceId", toJSON (browseAnnotationRequestResourceId value))]]) <> fmap toJSON (withoutFields ["annotationId", "resourceId"] (browseAnnotationRequestAdditionalProperties value)))

