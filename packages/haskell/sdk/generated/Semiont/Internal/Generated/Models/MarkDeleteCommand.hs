-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MarkDeleteCommand
  ( MarkDeleteCommand(..)
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
import Semiont.Internal.Generated.Models.UserId
data MarkDeleteCommand = MarkDeleteCommand { markDeleteCommandU5f_userId :: Maybe (UserId), markDeleteCommandAnnotationId :: AnnotationId, markDeleteCommandResourceId :: Maybe (ResourceId), markDeleteCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MarkDeleteCommand where
  parseJSON = checked "MarkDeleteCommand" $ withObject "MarkDeleteCommand" (\fields -> MarkDeleteCommand <$> optional fields "_userId" <*> fields .: "annotationId" <*> optional fields "resourceId" <*> traverse parseJSON (withoutFields ["_userId", "annotationId", "resourceId"] fields))
instance ToJSON MarkDeleteCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (markDeleteCommandU5f_userId value), [("annotationId", toJSON (markDeleteCommandAnnotationId value))], optionalPair "resourceId" (markDeleteCommandResourceId value)]) <> fmap toJSON (withoutFields ["_userId", "annotationId", "resourceId"] (markDeleteCommandAdditionalProperties value)))
