-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GatherSummaryRequest
  ( GatherSummaryRequest(..)
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
data GatherSummaryRequest = GatherSummaryRequest { gatherSummaryRequestAnnotationId :: AnnotationId, gatherSummaryRequestResourceId :: ResourceId, gatherSummaryRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatherSummaryRequest where
  parseJSON = checked "GatherSummaryRequest" $ withObject "GatherSummaryRequest" (\fields -> GatherSummaryRequest <$> fields .: "annotationId" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["annotationId", "resourceId"] fields))
instance ToJSON GatherSummaryRequest where toJSON value = Object (KM.fromList (concat [[("annotationId", toJSON (gatherSummaryRequestAnnotationId value))], [("resourceId", toJSON (gatherSummaryRequestResourceId value))]]) <> fmap toJSON (withoutFields ["annotationId", "resourceId"] (gatherSummaryRequestAdditionalProperties value)))
