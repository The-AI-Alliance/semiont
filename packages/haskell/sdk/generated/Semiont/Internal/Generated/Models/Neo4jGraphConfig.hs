-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.Neo4jGraphConfig
  ( Neo4jGraphConfig(..)
  , Neo4jGraphConfigType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data Neo4jGraphConfig = Neo4jGraphConfig { neo4jGraphConfigDatabase :: Text, neo4jGraphConfigPasswordEnv :: Text, neo4jGraphConfigType :: Neo4jGraphConfigType, neo4jGraphConfigUri :: Text, neo4jGraphConfigUsername :: Text } deriving (Eq, Show)
instance FromJSON Neo4jGraphConfig where
  parseJSON = checked "Neo4jGraphConfig" $ withObject "Neo4jGraphConfig" (\fields -> Neo4jGraphConfig <$> fields .: "database" <*> fields .: "passwordEnv" <*> fields .: "type" <*> fields .: "uri" <*> fields .: "username")
instance ToJSON Neo4jGraphConfig where toJSON value = Object (KM.fromList (concat [[("database", toJSON (neo4jGraphConfigDatabase value))], [("passwordEnv", toJSON (neo4jGraphConfigPasswordEnv value))], [("type", toJSON (neo4jGraphConfigType value))], [("uri", toJSON (neo4jGraphConfigUri value))], [("username", toJSON (neo4jGraphConfigUsername value))]]))

data Neo4jGraphConfigType = Neo4jGraphConfigTypeNeo4j deriving (Eq, Show)
instance FromJSON Neo4jGraphConfigType where
  parseJSON = checked "Neo4jGraphConfigType" $ \value -> if value == (String "neo4j") then pure Neo4jGraphConfigTypeNeo4j else fail "unknown enumeration member"
instance ToJSON Neo4jGraphConfigType where
  toJSON Neo4jGraphConfigTypeNeo4j = String "neo4j"
