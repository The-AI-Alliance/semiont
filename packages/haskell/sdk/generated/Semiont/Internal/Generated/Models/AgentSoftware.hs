-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AgentSoftware
  ( AgentSoftware(..)
  , AgentSoftwareParameters(..)
  , AgentSoftwareU40_type(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data AgentSoftware = AgentSoftware { agentSoftwareU40_id :: Maybe (Text), agentSoftwareU40_type :: AgentSoftwareU40_type, agentSoftwareModel :: Maybe (Text), agentSoftwareName :: Maybe (Text), agentSoftwareParameters :: Maybe (AgentSoftwareParameters), agentSoftwareProvider :: Maybe (Text), agentSoftwareAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON AgentSoftware where
  parseJSON = checked "AgentSoftware" $ withObject "AgentSoftware" (\fields -> AgentSoftware <$> optional fields "@id" <*> fields .: "@type" <*> optional fields "model" <*> optional fields "name" <*> optional fields "parameters" <*> optional fields "provider" <*> traverse parseJSON (withoutFields ["@id", "@type", "model", "name", "parameters", "provider"] fields))
instance ToJSON AgentSoftware where toJSON value = Object (KM.fromList (concat [optionalPair "@id" (agentSoftwareU40_id value), [("@type", toJSON (agentSoftwareU40_type value))], optionalPair "model" (agentSoftwareModel value), optionalPair "name" (agentSoftwareName value), optionalPair "parameters" (agentSoftwareParameters value), optionalPair "provider" (agentSoftwareProvider value)]) <> fmap toJSON (withoutFields ["@id", "@type", "model", "name", "parameters", "provider"] (agentSoftwareAdditionalProperties value)))

data AgentSoftwareParameters = AgentSoftwareParameters { agentSoftwareParametersAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON AgentSoftwareParameters where
  parseJSON = checked "AgentSoftwareParameters" $ withObject "AgentSoftwareParameters" (\fields -> AgentSoftwareParameters <$> traverse parseJSON (withoutFields [] fields))
instance ToJSON AgentSoftwareParameters where toJSON value = Object (KM.fromList (concat []) <> fmap toJSON (withoutFields [] (agentSoftwareParametersAdditionalProperties value)))

data AgentSoftwareU40_type = AgentSoftwareU40_typeSoftware deriving (Eq, Show)
instance FromJSON AgentSoftwareU40_type where
  parseJSON = checked "AgentSoftwareU40_type" $ \value -> if value == (String "Software") then pure AgentSoftwareU40_typeSoftware else fail "unknown enumeration member"
instance ToJSON AgentSoftwareU40_type where
  toJSON AgentSoftwareU40_typeSoftware = String "Software"


