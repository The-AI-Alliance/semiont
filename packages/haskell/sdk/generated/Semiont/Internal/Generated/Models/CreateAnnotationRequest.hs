-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.CreateAnnotationRequest
  ( CreateAnnotationRequest(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnnotationBodies
import Semiont.Internal.Generated.Models.AnnotationTarget
import Semiont.Internal.Generated.Models.Motivation
data CreateAnnotationRequest = CreateAnnotationRequest { createAnnotationRequestBody :: Maybe (AnnotationBodies), createAnnotationRequestMotivation :: Motivation, createAnnotationRequestTarget :: AnnotationTarget, createAnnotationRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON CreateAnnotationRequest where
  parseJSON = checked "CreateAnnotationRequest" $ withObject "CreateAnnotationRequest" (\fields -> CreateAnnotationRequest <$> optional fields "body" <*> fields .: "motivation" <*> fields .: "target" <*> traverse parseJSON (withoutFields ["body", "motivation", "target"] fields))
instance ToJSON CreateAnnotationRequest where toJSON value = Object (KM.fromList (concat [optionalPair "body" (createAnnotationRequestBody value), [("motivation", toJSON (createAnnotationRequestMotivation value))], [("target", toJSON (createAnnotationRequestTarget value))]]) <> fmap toJSON (withoutFields ["body", "motivation", "target"] (createAnnotationRequestAdditionalProperties value)))
