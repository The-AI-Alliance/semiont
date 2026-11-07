-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BindInitiateCommand
  ( BindInitiateCommand(..)
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
data BindInitiateCommand = BindInitiateCommand { bindInitiateCommandAnnotationId :: AnnotationId, bindInitiateCommandDefaultTitle :: Text, bindInitiateCommandEntityTypes :: [Text], bindInitiateCommandResourceId :: ResourceId, bindInitiateCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BindInitiateCommand where
  parseJSON = checked "BindInitiateCommand" $ withObject "BindInitiateCommand" (\fields -> BindInitiateCommand <$> fields .: "annotationId" <*> fields .: "defaultTitle" <*> fields .: "entityTypes" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["annotationId", "defaultTitle", "entityTypes", "resourceId"] fields))
instance ToJSON BindInitiateCommand where toJSON value = Object (KM.fromList (concat [[("annotationId", toJSON (bindInitiateCommandAnnotationId value))], [("defaultTitle", toJSON (bindInitiateCommandDefaultTitle value))], [("entityTypes", toJSON (bindInitiateCommandEntityTypes value))], [("resourceId", toJSON (bindInitiateCommandResourceId value))]]) <> fmap toJSON (withoutFields ["annotationId", "defaultTitle", "entityTypes", "resourceId"] (bindInitiateCommandAdditionalProperties value)))
