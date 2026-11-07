-- Generated from packages/typescript/sdk/src/state/flows/mark-state-unit.ts; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.PendingAnnotation where
import Data.Aeson (FromJSON(..), ToJSON(..), withObject, object, (.:), (.=))
import Semiont.Types (AnnotationSelector, Motivation)
data PendingAnnotation = PendingAnnotation { pendingAnnotationSelector :: AnnotationSelector, pendingAnnotationMotivation :: Motivation } deriving (Eq, Show)
instance FromJSON PendingAnnotation where
  parseJSON = withObject "PendingAnnotation" (\fields -> PendingAnnotation <$> fields .: "selector" <*> fields .: "motivation")
instance ToJSON PendingAnnotation where
  toJSON pending = object ["selector" .= pendingAnnotationSelector pending, "motivation" .= pendingAnnotationMotivation pending]
