-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.Agent
  ( Agent(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AgentOrganization
import Semiont.Internal.Generated.Models.AgentPerson
import Semiont.Internal.Generated.Models.AgentSoftware
data Agent = AgentBranch1 (AgentPerson) | AgentBranch2 (AgentOrganization) | AgentBranch3 (AgentSoftware) deriving (Eq, Show)
instance FromJSON Agent where
  parseJSON = checked "Agent" $ \value -> (AgentBranch1 <$> parseJSON value) <|> (AgentBranch2 <$> parseJSON value) <|> (AgentBranch3 <$> parseJSON value)
instance ToJSON Agent where
  toJSON (AgentBranch1 value) = toJSON value
  toJSON (AgentBranch2 value) = toJSON value
  toJSON (AgentBranch3 value) = toJSON value


