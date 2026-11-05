-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GatherAnnotationComplete
  ( GatherAnnotationComplete(..)
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
import Semiont.Internal.Generated.Models.GatheredContext
data GatherAnnotationComplete = GatherAnnotationComplete { gatherAnnotationCompleteAnnotationId :: AnnotationId, gatherAnnotationCompleteResponse :: GatheredContext, gatherAnnotationCompleteAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatherAnnotationComplete where
  parseJSON = checked "GatherAnnotationComplete" $ withObject "GatherAnnotationComplete" (\fields -> GatherAnnotationComplete <$> fields .: "annotationId" <*> fields .: "response" <*> traverse parseJSON (withoutFields ["annotationId", "response"] fields))
instance ToJSON GatherAnnotationComplete where toJSON value = Object (KM.fromList (concat [[("annotationId", toJSON (gatherAnnotationCompleteAnnotationId value))], [("response", toJSON (gatherAnnotationCompleteResponse value))]]) <> fmap toJSON (withoutFields ["annotationId", "response"] (gatherAnnotationCompleteAdditionalProperties value)))
