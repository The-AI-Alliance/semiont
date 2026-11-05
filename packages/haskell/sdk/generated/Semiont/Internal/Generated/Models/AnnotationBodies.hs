-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnnotationBodies
  ( AnnotationBodies(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnnotationBody
data AnnotationBodies = AnnotationBodiesBranch1 (AnnotationBody) | AnnotationBodiesBranch2 ([AnnotationBody]) deriving (Eq, Show)
instance FromJSON AnnotationBodies where
  parseJSON = checked "AnnotationBodies" $ \value -> (AnnotationBodiesBranch1 <$> parseJSON value) <|> (AnnotationBodiesBranch2 <$> parseJSON value)
instance ToJSON AnnotationBodies where
  toJSON (AnnotationBodiesBranch1 value) = toJSON value
  toJSON (AnnotationBodiesBranch2 value) = toJSON value


