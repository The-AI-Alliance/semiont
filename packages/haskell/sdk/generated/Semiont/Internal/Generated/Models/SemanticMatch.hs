-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.SemanticMatch
  ( SemanticMatch(..)
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
data SemanticMatch = SemanticMatch { semanticMatchAnnotationId :: Maybe (AnnotationId), semanticMatchEntityTypes :: Maybe ([Text]), semanticMatchMachineRead :: Maybe (Bool), semanticMatchResourceId :: ResourceId, semanticMatchResourceName :: Text, semanticMatchScore :: Scientific, semanticMatchText :: Text, semanticMatchAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON SemanticMatch where
  parseJSON = checked "SemanticMatch" $ withObject "SemanticMatch" (\fields -> SemanticMatch <$> optional fields "annotationId" <*> optional fields "entityTypes" <*> optional fields "machineRead" <*> fields .: "resourceId" <*> fields .: "resourceName" <*> fields .: "score" <*> fields .: "text" <*> traverse parseJSON (withoutFields ["annotationId", "entityTypes", "machineRead", "resourceId", "resourceName", "score", "text"] fields))
instance ToJSON SemanticMatch where toJSON value = Object (KM.fromList (concat [optionalPair "annotationId" (semanticMatchAnnotationId value), optionalPair "entityTypes" (semanticMatchEntityTypes value), optionalPair "machineRead" (semanticMatchMachineRead value), [("resourceId", toJSON (semanticMatchResourceId value))], [("resourceName", toJSON (semanticMatchResourceName value))], [("score", toJSON (semanticMatchScore value))], [("text", toJSON (semanticMatchText value))]]) <> fmap toJSON (withoutFields ["annotationId", "entityTypes", "machineRead", "resourceId", "resourceName", "score", "text"] (semanticMatchAdditionalProperties value)))

