-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.CursorsPath
  ( CursorsPath(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
newtype CursorsPath = CursorsPath { cursorsPathValue :: Text } deriving (Eq, Show)
instance FromJSON CursorsPath where
  parseJSON = checked "CursorsPath" $ \value -> CursorsPath <$> parseJSON value
instance ToJSON CursorsPath where toJSON (CursorsPath value) = toJSON value

