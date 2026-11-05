-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.Annotation
  ( Annotation(..)
  , AnnotationGenerator(..)
  , AnnotationTargetInline(..)
  , AnnotationType(..)
  , AnnotationU40_context(..)
  , AnnotationWasAttributedTo(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Agent
import Semiont.Internal.Generated.Models.AnnotationBodies
import Semiont.Internal.Generated.Models.AnnotationId
import Semiont.Internal.Generated.Models.AnnotationTarget
import Semiont.Internal.Generated.Models.Motivation
import Semiont.Internal.Generated.Models.ResourceId
data Annotation = Annotation { annotationU40_context :: AnnotationU40_context, annotationBody :: Maybe (AnnotationBodies), annotationCreated :: Text, annotationCreator :: Maybe (Agent), annotationGenerator :: Maybe (AnnotationGenerator), annotationId :: AnnotationId, annotationModified :: Maybe (Text), annotationMotivation :: Motivation, annotationTarget :: AnnotationTargetInline, annotationType :: AnnotationType, annotationWasAttributedTo :: Maybe (AnnotationWasAttributedTo), annotationAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON Annotation where
  parseJSON = checked "Annotation" $ withObject "Annotation" (\fields -> Annotation <$> fields .: "@context" <*> optional fields "body" <*> fields .: "created" <*> optional fields "creator" <*> optional fields "generator" <*> fields .: "id" <*> optional fields "modified" <*> fields .: "motivation" <*> fields .: "target" <*> fields .: "type" <*> optional fields "wasAttributedTo" <*> traverse parseJSON (withoutFields ["@context", "body", "created", "creator", "generator", "id", "modified", "motivation", "target", "type", "wasAttributedTo"] fields))
instance ToJSON Annotation where toJSON value = Object (KM.fromList (concat [[("@context", toJSON (annotationU40_context value))], optionalPair "body" (annotationBody value), [("created", toJSON (annotationCreated value))], optionalPair "creator" (annotationCreator value), optionalPair "generator" (annotationGenerator value), [("id", toJSON (annotationId value))], optionalPair "modified" (annotationModified value), [("motivation", toJSON (annotationMotivation value))], [("target", toJSON (annotationTarget value))], [("type", toJSON (annotationType value))], optionalPair "wasAttributedTo" (annotationWasAttributedTo value)]) <> fmap toJSON (withoutFields ["@context", "body", "created", "creator", "generator", "id", "modified", "motivation", "target", "type", "wasAttributedTo"] (annotationAdditionalProperties value)))

data AnnotationGenerator = AnnotationGeneratorBranch1 (Agent) | AnnotationGeneratorBranch2 ([Agent]) deriving (Eq, Show)
instance FromJSON AnnotationGenerator where
  parseJSON = checked "AnnotationGenerator" $ \value -> (AnnotationGeneratorBranch1 <$> parseJSON value) <|> (AnnotationGeneratorBranch2 <$> parseJSON value)
instance ToJSON AnnotationGenerator where
  toJSON (AnnotationGeneratorBranch1 value) = toJSON value
  toJSON (AnnotationGeneratorBranch2 value) = toJSON value


data AnnotationTargetInline = AnnotationTargetInlineBranch1 (ResourceId) | AnnotationTargetInlineBranch2 (AnnotationTarget) deriving (Eq, Show)
instance FromJSON AnnotationTargetInline where
  parseJSON = checked "AnnotationTargetInline" $ \value -> (AnnotationTargetInlineBranch1 <$> parseJSON value) <|> (AnnotationTargetInlineBranch2 <$> parseJSON value)
instance ToJSON AnnotationTargetInline where
  toJSON (AnnotationTargetInlineBranch1 value) = toJSON value
  toJSON (AnnotationTargetInlineBranch2 value) = toJSON value


data AnnotationType = AnnotationTypeAnnotation deriving (Eq, Show)
instance FromJSON AnnotationType where
  parseJSON = checked "AnnotationType" $ \value -> if value == (String "Annotation") then pure AnnotationTypeAnnotation else fail "unknown enumeration member"
instance ToJSON AnnotationType where
  toJSON AnnotationTypeAnnotation = String "Annotation"


data AnnotationU40_context = AnnotationU40_contextHttpU3a_U2f_U2f_wwwU2e_w3U2e_orgU2f_nsU2f_annoU2e_jsonld deriving (Eq, Show)
instance FromJSON AnnotationU40_context where
  parseJSON = checked "AnnotationU40_context" $ \value -> if value == (String "http://www.w3.org/ns/anno.jsonld") then pure AnnotationU40_contextHttpU3a_U2f_U2f_wwwU2e_w3U2e_orgU2f_nsU2f_annoU2e_jsonld else fail "unknown enumeration member"
instance ToJSON AnnotationU40_context where
  toJSON AnnotationU40_contextHttpU3a_U2f_U2f_wwwU2e_w3U2e_orgU2f_nsU2f_annoU2e_jsonld = String "http://www.w3.org/ns/anno.jsonld"


data AnnotationWasAttributedTo = AnnotationWasAttributedToBranch1 (Agent) | AnnotationWasAttributedToBranch2 ([Agent]) deriving (Eq, Show)
instance FromJSON AnnotationWasAttributedTo where
  parseJSON = checked "AnnotationWasAttributedTo" $ \value -> (AnnotationWasAttributedToBranch1 <$> parseJSON value) <|> (AnnotationWasAttributedToBranch2 <$> parseJSON value)
instance ToJSON AnnotationWasAttributedTo where
  toJSON (AnnotationWasAttributedToBranch1 value) = toJSON value
  toJSON (AnnotationWasAttributedToBranch2 value) = toJSON value


