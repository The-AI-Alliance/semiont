-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.UploadResourceHeader0
  ( UploadResourceHeader0(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
newtype UploadResourceHeader0 = UploadResourceHeader0 { uploadResourceHeader0Value :: Text } deriving (Eq, Show)
instance FromJSON UploadResourceHeader0 where
  parseJSON = checked "UploadResourceHeader0" $ \value -> UploadResourceHeader0 <$> parseJSON value
instance ToJSON UploadResourceHeader0 where toJSON (UploadResourceHeader0 value) = toJSON value
