-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ResourceAnnotations
  ( ResourceAnnotations(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Annotation
import Semiont.Internal.Generated.Models.ResourceId
data ResourceAnnotations = ResourceAnnotations { resourceAnnotationsAnnotations :: [Annotation], resourceAnnotationsResourceId :: ResourceId, resourceAnnotationsUpdatedAt :: Text, resourceAnnotationsVersion :: Integer } deriving (Eq, Show)
instance FromJSON ResourceAnnotations where
  parseJSON = checked "ResourceAnnotations" $ withObject "ResourceAnnotations" (\fields -> ResourceAnnotations <$> fields .: "annotations" <*> fields .: "resourceId" <*> fields .: "updatedAt" <*> fields .: "version")
instance ToJSON ResourceAnnotations where toJSON value = Object (KM.fromList (concat [[("annotations", toJSON (resourceAnnotationsAnnotations value))], [("resourceId", toJSON (resourceAnnotationsResourceId value))], [("updatedAt", toJSON (resourceAnnotationsUpdatedAt value))], [("version", toJSON (resourceAnnotationsVersion value))]]))
