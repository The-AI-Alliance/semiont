-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnnotationId
  ( AnnotationId, annotationIdValue, mkAnnotationId
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
newtype AnnotationId = AnnotationId (Text) deriving (Eq, Show)
instance FromJSON AnnotationId where
  parseJSON = checked "AnnotationId" $ \value -> AnnotationId <$> parseJSON value
instance ToJSON AnnotationId where toJSON (AnnotationId value) = toJSON value
annotationIdValue :: AnnotationId -> Text
annotationIdValue (AnnotationId value) = value
mkAnnotationId :: Text -> Either String AnnotationId
mkAnnotationId value = parseEither parseJSON (toJSON value)

