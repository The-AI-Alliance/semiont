-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.SmelterConfig
  ( SmelterConfig(..)
  , SmelterConfigArchivist(..)
  , SmelterConfigChunking(..)
  , SmelterConfigIdentity(..)
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
import Semiont.Internal.Generated.Models.EmbeddingConfig
import Semiont.Internal.Generated.Models.KbIdentity
import Semiont.Internal.Generated.Models.LogFormat
import Semiont.Internal.Generated.Models.LogLevel
import Semiont.Internal.Generated.Models.VectorsConfig
data SmelterConfig = SmelterConfig { smelterConfigArchivist :: SmelterConfigArchivist, smelterConfigChunking :: SmelterConfigChunking, smelterConfigCursorsPath :: CursorsPath, smelterConfigEmbedding :: EmbeddingConfig, smelterConfigGatewayUrl :: Text, smelterConfigIdentity :: SmelterConfigIdentity, smelterConfigKb :: KbIdentity, smelterConfigLogFormat :: LogFormat, smelterConfigLogLevel :: LogLevel, smelterConfigPdfsAtOnce :: Integer, smelterConfigPort :: Integer, smelterConfigVectors :: VectorsConfig } deriving (Eq, Show)
instance FromJSON SmelterConfig where
  parseJSON = checked "SmelterConfig" $ withObject "SmelterConfig" (\fields -> SmelterConfig <$> fields .: "archivist" <*> fields .: "chunking" <*> fields .: "cursorsPath" <*> fields .: "embedding" <*> fields .: "gatewayUrl" <*> fields .: "identity" <*> fields .: "kb" <*> fields .: "logFormat" <*> fields .: "logLevel" <*> fields .: "pdfsAtOnce" <*> fields .: "port" <*> fields .: "vectors")
instance ToJSON SmelterConfig where toJSON value = Object (KM.fromList (concat [[("archivist", toJSON (smelterConfigArchivist value))], [("chunking", toJSON (smelterConfigChunking value))], [("cursorsPath", toJSON (smelterConfigCursorsPath value))], [("embedding", toJSON (smelterConfigEmbedding value))], [("gatewayUrl", toJSON (smelterConfigGatewayUrl value))], [("identity", toJSON (smelterConfigIdentity value))], [("kb", toJSON (smelterConfigKb value))], [("logFormat", toJSON (smelterConfigLogFormat value))], [("logLevel", toJSON (smelterConfigLogLevel value))], [("pdfsAtOnce", toJSON (smelterConfigPdfsAtOnce value))], [("port", toJSON (smelterConfigPort value))], [("vectors", toJSON (smelterConfigVectors value))]]))

data SmelterConfigArchivist = SmelterConfigArchivist { smelterConfigArchivistHost :: Text, smelterConfigArchivistPort :: Integer } deriving (Eq, Show)
instance FromJSON SmelterConfigArchivist where
  parseJSON = checked "SmelterConfigArchivist" $ withObject "SmelterConfigArchivist" (\fields -> SmelterConfigArchivist <$> fields .: "host" <*> fields .: "port")
instance ToJSON SmelterConfigArchivist where toJSON value = Object (KM.fromList (concat [[("host", toJSON (smelterConfigArchivistHost value))], [("port", toJSON (smelterConfigArchivistPort value))]]))

data SmelterConfigChunking = SmelterConfigChunking { smelterConfigChunkingChunkSize :: Integer, smelterConfigChunkingOverlap :: Integer } deriving (Eq, Show)
instance FromJSON SmelterConfigChunking where
  parseJSON = checked "SmelterConfigChunking" $ withObject "SmelterConfigChunking" (\fields -> SmelterConfigChunking <$> fields .: "chunkSize" <*> fields .: "overlap")
instance ToJSON SmelterConfigChunking where toJSON value = Object (KM.fromList (concat [[("chunkSize", toJSON (smelterConfigChunkingChunkSize value))], [("overlap", toJSON (smelterConfigChunkingOverlap value))]]))

data SmelterConfigIdentity = SmelterConfigIdentity { smelterConfigIdentityIssuer :: Text } deriving (Eq, Show)
instance FromJSON SmelterConfigIdentity where
  parseJSON = checked "SmelterConfigIdentity" $ withObject "SmelterConfigIdentity" (\fields -> SmelterConfigIdentity <$> fields .: "issuer")
instance ToJSON SmelterConfigIdentity where toJSON value = Object (KM.fromList (concat [[("issuer", toJSON (smelterConfigIdentityIssuer value))]]))
