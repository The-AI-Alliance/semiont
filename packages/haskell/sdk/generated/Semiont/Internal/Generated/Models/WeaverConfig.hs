-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.WeaverConfig
  ( WeaverConfig(..)
  , WeaverConfigArchivist(..)
  , WeaverConfigIdentity(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.CursorsPath
import Semiont.Internal.Generated.Models.GraphConfig
import Semiont.Internal.Generated.Models.KbIdentity
import Semiont.Internal.Generated.Models.LogFormat
import Semiont.Internal.Generated.Models.LogLevel
data WeaverConfig = WeaverConfig { weaverConfigArchivist :: WeaverConfigArchivist, weaverConfigCursorsPath :: CursorsPath, weaverConfigGatewayUrl :: Text, weaverConfigGraph :: GraphConfig, weaverConfigIdentity :: WeaverConfigIdentity, weaverConfigKb :: KbIdentity, weaverConfigLogFormat :: LogFormat, weaverConfigLogLevel :: LogLevel, weaverConfigPort :: Integer } deriving (Eq, Show)
instance FromJSON WeaverConfig where
  parseJSON = checked "WeaverConfig" $ withObject "WeaverConfig" (\fields -> WeaverConfig <$> fields .: "archivist" <*> fields .: "cursorsPath" <*> fields .: "gatewayUrl" <*> fields .: "graph" <*> fields .: "identity" <*> fields .: "kb" <*> fields .: "logFormat" <*> fields .: "logLevel" <*> fields .: "port")
instance ToJSON WeaverConfig where toJSON value = Object (KM.fromList (concat [[("archivist", toJSON (weaverConfigArchivist value))], [("cursorsPath", toJSON (weaverConfigCursorsPath value))], [("gatewayUrl", toJSON (weaverConfigGatewayUrl value))], [("graph", toJSON (weaverConfigGraph value))], [("identity", toJSON (weaverConfigIdentity value))], [("kb", toJSON (weaverConfigKb value))], [("logFormat", toJSON (weaverConfigLogFormat value))], [("logLevel", toJSON (weaverConfigLogLevel value))], [("port", toJSON (weaverConfigPort value))]]))

data WeaverConfigArchivist = WeaverConfigArchivist { weaverConfigArchivistHost :: Text, weaverConfigArchivistPort :: Integer } deriving (Eq, Show)
instance FromJSON WeaverConfigArchivist where
  parseJSON = checked "WeaverConfigArchivist" $ withObject "WeaverConfigArchivist" (\fields -> WeaverConfigArchivist <$> fields .: "host" <*> fields .: "port")
instance ToJSON WeaverConfigArchivist where toJSON value = Object (KM.fromList (concat [[("host", toJSON (weaverConfigArchivistHost value))], [("port", toJSON (weaverConfigArchivistPort value))]]))

data WeaverConfigIdentity = WeaverConfigIdentity { weaverConfigIdentityIssuer :: Text } deriving (Eq, Show)
instance FromJSON WeaverConfigIdentity where
  parseJSON = checked "WeaverConfigIdentity" $ withObject "WeaverConfigIdentity" (\fields -> WeaverConfigIdentity <$> fields .: "issuer")
instance ToJSON WeaverConfigIdentity where toJSON value = Object (KM.fromList (concat [[("issuer", toJSON (weaverConfigIdentityIssuer value))]]))
