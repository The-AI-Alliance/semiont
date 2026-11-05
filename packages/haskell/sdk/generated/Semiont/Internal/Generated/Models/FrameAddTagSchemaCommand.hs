-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.FrameAddTagSchemaCommand
  ( FrameAddTagSchemaCommand(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.TagSchema
import Semiont.Internal.Generated.Models.UserId
data FrameAddTagSchemaCommand = FrameAddTagSchemaCommand { frameAddTagSchemaCommandU5f_userId :: Maybe (UserId), frameAddTagSchemaCommandSchema :: TagSchema, frameAddTagSchemaCommandAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON FrameAddTagSchemaCommand where
  parseJSON = checked "FrameAddTagSchemaCommand" $ withObject "FrameAddTagSchemaCommand" (\fields -> FrameAddTagSchemaCommand <$> optional fields "_userId" <*> fields .: "schema" <*> traverse parseJSON (withoutFields ["_userId", "schema"] fields))
instance ToJSON FrameAddTagSchemaCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_userId" (frameAddTagSchemaCommandU5f_userId value), [("schema", toJSON (frameAddTagSchemaCommandSchema value))]]) <> fmap toJSON (withoutFields ["_userId", "schema"] (frameAddTagSchemaCommandAdditionalProperties value)))

