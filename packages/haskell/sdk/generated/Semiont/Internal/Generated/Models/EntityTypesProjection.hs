-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.EntityTypesProjection
  ( EntityTypesProjection(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data EntityTypesProjection = EntityTypesProjection { entityTypesProjectionEntityTypes :: [Text] } deriving (Eq, Show)
instance FromJSON EntityTypesProjection where
  parseJSON = checked "EntityTypesProjection" $ withObject "EntityTypesProjection" (\fields -> EntityTypesProjection <$> fields .: "entityTypes")
instance ToJSON EntityTypesProjection where toJSON value = Object (KM.fromList (concat [[("entityTypes", toJSON (entityTypesProjectionEntityTypes value))]]))

