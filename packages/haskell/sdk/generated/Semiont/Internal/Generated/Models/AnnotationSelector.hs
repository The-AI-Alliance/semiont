-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnnotationSelector
  ( AnnotationSelector(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Selector
data AnnotationSelector = AnnotationSelectorBranch1 (Selector) | AnnotationSelectorBranch2 ([Selector]) deriving (Eq, Show)
instance FromJSON AnnotationSelector where
  parseJSON = checked "AnnotationSelector" $ \value -> (AnnotationSelectorBranch1 <$> parseJSON value) <|> (AnnotationSelectorBranch2 <$> parseJSON value)
instance ToJSON AnnotationSelector where
  toJSON (AnnotationSelectorBranch1 value) = toJSON value
  toJSON (AnnotationSelectorBranch2 value) = toJSON value
