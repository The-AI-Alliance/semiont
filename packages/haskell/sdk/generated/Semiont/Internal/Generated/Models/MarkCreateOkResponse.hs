-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MarkCreateOkResponse
  ( MarkCreateOkResponse(..)
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
data MarkCreateOkResponse = MarkCreateOkResponse { markCreateOkResponseAnnotationId :: AnnotationId, markCreateOkResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MarkCreateOkResponse where
  parseJSON = checked "MarkCreateOkResponse" $ withObject "MarkCreateOkResponse" (\fields -> MarkCreateOkResponse <$> fields .: "annotationId" <*> traverse parseJSON (withoutFields ["annotationId"] fields))
instance ToJSON MarkCreateOkResponse where toJSON value = Object (KM.fromList (concat [[("annotationId", toJSON (markCreateOkResponseAnnotationId value))]]) <> fmap toJSON (withoutFields ["annotationId"] (markCreateOkResponseAdditionalProperties value)))

