-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.SessionEnded
  ( SessionEnded(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.SessionEndReason
data SessionEnded = SessionEnded { sessionEndedReason :: SessionEndReason } deriving (Eq, Show)
instance FromJSON SessionEnded where
  parseJSON = checked "SessionEnded" $ withObject "SessionEnded" (\fields -> SessionEnded <$> fields .: "reason")
instance ToJSON SessionEnded where toJSON value = Object (KM.fromList (concat [[("reason", toJSON (sessionEndedReason value))]]))
