-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.EngineLimits
  ( EngineLimits(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Engine
import Semiont.Internal.Generated.Models.InferenceLimits
data EngineLimits = EngineLimits { engineLimitsEngine :: Engine, engineLimitsLimits :: InferenceLimits } deriving (Eq, Show)
instance FromJSON EngineLimits where
  parseJSON = checked "EngineLimits" $ withObject "EngineLimits" (\fields -> EngineLimits <$> fields .: "engine" <*> fields .: "limits")
instance ToJSON EngineLimits where toJSON value = Object (KM.fromList (concat [[("engine", toJSON (engineLimitsEngine value))], [("limits", toJSON (engineLimitsLimits value))]]))
