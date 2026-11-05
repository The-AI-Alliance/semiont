-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.LogLevel
  ( LogLevel(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data LogLevel = LogLevelError | LogLevelWarn | LogLevelInfo | LogLevelHttp | LogLevelDebug deriving (Eq, Show)
instance FromJSON LogLevel where
  parseJSON = checked "LogLevel" $ \value -> if value == (String "error") then pure LogLevelError else if value == (String "warn") then pure LogLevelWarn else if value == (String "info") then pure LogLevelInfo else if value == (String "http") then pure LogLevelHttp else if value == (String "debug") then pure LogLevelDebug else fail "unknown enumeration member"
instance ToJSON LogLevel where
  toJSON LogLevelError = String "error"
  toJSON LogLevelWarn = String "warn"
  toJSON LogLevelInfo = String "info"
  toJSON LogLevelHttp = String "http"
  toJSON LogLevelDebug = String "debug"


