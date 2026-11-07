-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BindUpdateBodyCommand
  ( BindUpdateBodyCommand(..)
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
import Semiont.Internal.Generated.Models.BindBodyOperation
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data BindUpdateBodyCommand = BindUpdateBodyCommand { bindUpdateBodyCommandU5f_userId :: Maybe (UserId), bindUpdateBodyCommandAnnotationId :: AnnotationId, bindUpdateBodyCommandOperations :: [BindBodyOperation], bindUpdateBodyCommandResourceId :: ResourceId, bindUpdateBodyCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BindUpdateBodyCommand where
  parseJSON = checked "BindUpdateBodyCommand" $ withObject "BindUpdateBodyCommand" (\fields -> BindUpdateBodyCommand <$> optional fields "_userId" <*> fields .: "annotationId" <*> fields .: "operations" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["_userId", "annotationId", "operations", "resourceId"] fields))
instance ToJSON BindUpdateBodyCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (bindUpdateBodyCommandU5f_userId value), [("annotationId", toJSON (bindUpdateBodyCommandAnnotationId value))], [("operations", toJSON (bindUpdateBodyCommandOperations value))], [("resourceId", toJSON (bindUpdateBodyCommandResourceId value))]]) <> fmap toJSON (withoutFields ["_userId", "annotationId", "operations", "resourceId"] (bindUpdateBodyCommandAdditionalProperties value)))
