-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ArchivistStreamsResponse
  ( ArchivistStreamsResponse(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.ArchivistStream
data ArchivistStreamsResponse = ArchivistStreamsResponse { archivistStreamsResponseStreams :: [ArchivistStream] } deriving (Eq, Show)
instance FromJSON ArchivistStreamsResponse where
  parseJSON = checked "ArchivistStreamsResponse" $ withObject "ArchivistStreamsResponse" (\fields -> ArchivistStreamsResponse <$> fields .: "streams")
instance ToJSON ArchivistStreamsResponse where toJSON value = Object (KM.fromList (concat [[("streams", toJSON (archivistStreamsResponseStreams value))]]))

