-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BrowseAnnotationHistoryRequest
  ( BrowseAnnotationHistoryRequest(..)
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
data BrowseAnnotationHistoryRequest = BrowseAnnotationHistoryRequest { browseAnnotationHistoryRequestAnnotationId :: AnnotationId, browseAnnotationHistoryRequestResourceId :: ResourceId, browseAnnotationHistoryRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BrowseAnnotationHistoryRequest where
  parseJSON = checked "BrowseAnnotationHistoryRequest" $ withObject "BrowseAnnotationHistoryRequest" (\fields -> BrowseAnnotationHistoryRequest <$> fields .: "annotationId" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["annotationId", "resourceId"] fields))
instance ToJSON BrowseAnnotationHistoryRequest where toJSON value = Object (KM.fromList (concat [[("annotationId", toJSON (browseAnnotationHistoryRequestAnnotationId value))], [("resourceId", toJSON (browseAnnotationHistoryRequestResourceId value))]]) <> fmap toJSON (withoutFields ["annotationId", "resourceId"] (browseAnnotationHistoryRequestAdditionalProperties value)))
