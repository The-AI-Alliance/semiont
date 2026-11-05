-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.LibrarianConfig
  ( LibrarianConfig(..)
  , LibrarianConfigArchivist(..)
  , LibrarianConfigGather(..)
  , LibrarianConfigIdentity(..)
  , LibrarianConfigSearch(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.EmbeddingConfig
import Semiont.Internal.Generated.Models.GraphConfig
import Semiont.Internal.Generated.Models.KbIdentity
import Semiont.Internal.Generated.Models.LibrarianEngineConfig
import Semiont.Internal.Generated.Models.LogFormat
import Semiont.Internal.Generated.Models.LogLevel
import Semiont.Internal.Generated.Models.VectorsConfig
data LibrarianConfig = LibrarianConfig { librarianConfigArchivist :: LibrarianConfigArchivist, librarianConfigEmbedding :: EmbeddingConfig, librarianConfigGatewayUrl :: Text, librarianConfigGather :: LibrarianConfigGather, librarianConfigGatherer :: LibrarianEngineConfig, librarianConfigGraph :: GraphConfig, librarianConfigIdentity :: LibrarianConfigIdentity, librarianConfigKb :: KbIdentity, librarianConfigLogFormat :: LogFormat, librarianConfigLogLevel :: LogLevel, librarianConfigMatcher :: LibrarianEngineConfig, librarianConfigModelCatalogue :: Text, librarianConfigPort :: Integer, librarianConfigSearch :: LibrarianConfigSearch, librarianConfigVectors :: VectorsConfig } deriving (Eq, Show)
instance FromJSON LibrarianConfig where
  parseJSON = checked "LibrarianConfig" $ withObject "LibrarianConfig" (\fields -> LibrarianConfig <$> fields .: "archivist" <*> fields .: "embedding" <*> fields .: "gatewayUrl" <*> fields .: "gather" <*> fields .: "gatherer" <*> fields .: "graph" <*> fields .: "identity" <*> fields .: "kb" <*> fields .: "logFormat" <*> fields .: "logLevel" <*> fields .: "matcher" <*> fields .: "modelCatalogue" <*> fields .: "port" <*> fields .: "search" <*> fields .: "vectors")
instance ToJSON LibrarianConfig where toJSON value = Object (KM.fromList (concat [[("archivist", toJSON (librarianConfigArchivist value))], [("embedding", toJSON (librarianConfigEmbedding value))], [("gatewayUrl", toJSON (librarianConfigGatewayUrl value))], [("gather", toJSON (librarianConfigGather value))], [("gatherer", toJSON (librarianConfigGatherer value))], [("graph", toJSON (librarianConfigGraph value))], [("identity", toJSON (librarianConfigIdentity value))], [("kb", toJSON (librarianConfigKb value))], [("logFormat", toJSON (librarianConfigLogFormat value))], [("logLevel", toJSON (librarianConfigLogLevel value))], [("matcher", toJSON (librarianConfigMatcher value))], [("modelCatalogue", toJSON (librarianConfigModelCatalogue value))], [("port", toJSON (librarianConfigPort value))], [("search", toJSON (librarianConfigSearch value))], [("vectors", toJSON (librarianConfigVectors value))]]))

data LibrarianConfigArchivist = LibrarianConfigArchivist { librarianConfigArchivistHost :: Text, librarianConfigArchivistPort :: Integer } deriving (Eq, Show)
instance FromJSON LibrarianConfigArchivist where
  parseJSON = checked "LibrarianConfigArchivist" $ withObject "LibrarianConfigArchivist" (\fields -> LibrarianConfigArchivist <$> fields .: "host" <*> fields .: "port")
instance ToJSON LibrarianConfigArchivist where toJSON value = Object (KM.fromList (concat [[("host", toJSON (librarianConfigArchivistHost value))], [("port", toJSON (librarianConfigArchivistPort value))]]))

data LibrarianConfigGather = LibrarianConfigGather { librarianConfigGatherSettleTimeoutMs :: Integer } deriving (Eq, Show)
instance FromJSON LibrarianConfigGather where
  parseJSON = checked "LibrarianConfigGather" $ withObject "LibrarianConfigGather" (\fields -> LibrarianConfigGather <$> fields .: "settleTimeoutMs")
instance ToJSON LibrarianConfigGather where toJSON value = Object (KM.fromList (concat [[("settleTimeoutMs", toJSON (librarianConfigGatherSettleTimeoutMs value))]]))

data LibrarianConfigIdentity = LibrarianConfigIdentity { librarianConfigIdentityIssuer :: Text } deriving (Eq, Show)
instance FromJSON LibrarianConfigIdentity where
  parseJSON = checked "LibrarianConfigIdentity" $ withObject "LibrarianConfigIdentity" (\fields -> LibrarianConfigIdentity <$> fields .: "issuer")
instance ToJSON LibrarianConfigIdentity where toJSON value = Object (KM.fromList (concat [[("issuer", toJSON (librarianConfigIdentityIssuer value))]]))

data LibrarianConfigSearch = LibrarianConfigSearch { librarianConfigSearchSemanticFloor :: Scientific } deriving (Eq, Show)
instance FromJSON LibrarianConfigSearch where
  parseJSON = checked "LibrarianConfigSearch" $ withObject "LibrarianConfigSearch" (\fields -> LibrarianConfigSearch <$> fields .: "semanticFloor")
instance ToJSON LibrarianConfigSearch where toJSON value = Object (KM.fromList (concat [[("semanticFloor", toJSON (librarianConfigSearchSemanticFloor value))]]))

