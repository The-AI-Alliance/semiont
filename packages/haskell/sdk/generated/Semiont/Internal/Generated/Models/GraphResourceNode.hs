-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GraphResourceNode
  ( GraphResourceNode(..)
  , GraphResourceNodeMetadata(..)
  , GraphResourceNodeType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.ResourceId
data GraphResourceNode = GraphResourceNode { graphResourceNodeEntityTypes :: Maybe ([Text]), graphResourceNodeId :: ResourceId, graphResourceNodeLabel :: Text, graphResourceNodeMetadata :: Maybe (GraphResourceNodeMetadata), graphResourceNodeType :: GraphResourceNodeType, graphResourceNodeAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GraphResourceNode where
  parseJSON = checked "GraphResourceNode" $ withObject "GraphResourceNode" (\fields -> GraphResourceNode <$> optional fields "entityTypes" <*> fields .: "id" <*> fields .: "label" <*> optional fields "metadata" <*> fields .: "type" <*> traverse parseJSON (withoutFields ["entityTypes", "id", "label", "metadata", "type"] fields))
instance ToJSON GraphResourceNode where toJSON value = Object (KM.fromList (concat [optionalPair "entityTypes" (graphResourceNodeEntityTypes value), [("id", toJSON (graphResourceNodeId value))], [("label", toJSON (graphResourceNodeLabel value))], optionalPair "metadata" (graphResourceNodeMetadata value), [("type", toJSON (graphResourceNodeType value))]]) <> fmap toJSON (withoutFields ["entityTypes", "id", "label", "metadata", "type"] (graphResourceNodeAdditionalProperties value)))

data GraphResourceNodeMetadata = GraphResourceNodeMetadata { graphResourceNodeMetadataAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GraphResourceNodeMetadata where
  parseJSON = checked "GraphResourceNodeMetadata" $ withObject "GraphResourceNodeMetadata" (\fields -> GraphResourceNodeMetadata <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON GraphResourceNodeMetadata where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (graphResourceNodeMetadataAdditionalProperties value)))

data GraphResourceNodeType = GraphResourceNodeTypeResource deriving (Eq, Show)
instance FromJSON GraphResourceNodeType where
  parseJSON = checked "GraphResourceNodeType" $ \value -> if value == (String "resource") then pure GraphResourceNodeTypeResource else fail "unknown enumeration member"
instance ToJSON GraphResourceNodeType where
  toJSON GraphResourceNodeTypeResource = String "resource"
