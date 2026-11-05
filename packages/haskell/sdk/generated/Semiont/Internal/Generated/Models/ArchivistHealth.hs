-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ArchivistHealth
  ( ArchivistHealth(..)
  , ArchivistHealthStatus(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data ArchivistHealth = ArchivistHealth { archivistHealthActors :: [Text], archivistHealthStatus :: ArchivistHealthStatus, archivistHealthAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ArchivistHealth where
  parseJSON = checked "ArchivistHealth" $ withObject "ArchivistHealth" (\fields -> ArchivistHealth <$> fields .: "actors" <*> fields .: "status" <*> traverse parseJSON (withoutFields ["actors", "status"] fields))
instance ToJSON ArchivistHealth where toJSON value = Object (KM.fromList (concat [[("actors", toJSON (archivistHealthActors value))], [("status", toJSON (archivistHealthStatus value))]]) <> fmap toJSON (withoutFields ["actors", "status"] (archivistHealthAdditionalProperties value)))

data ArchivistHealthStatus = ArchivistHealthStatusOk deriving (Eq, Show)
instance FromJSON ArchivistHealthStatus where
  parseJSON = checked "ArchivistHealthStatus" $ \value -> if value == (String "ok") then pure ArchivistHealthStatusOk else fail "unknown enumeration member"
instance ToJSON ArchivistHealthStatus where
  toJSON ArchivistHealthStatusOk = String "ok"
