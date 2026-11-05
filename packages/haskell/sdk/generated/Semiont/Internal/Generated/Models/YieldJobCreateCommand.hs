-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.YieldJobCreateCommand
  ( YieldJobCreateCommand(..)
  , YieldJobCreateCommandJobType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.GenerationJobParams
import Semiont.Internal.Generated.Models.UserId
data YieldJobCreateCommand = YieldJobCreateCommand { yieldJobCreateCommandU5f_roles :: Maybe ([Text]), yieldJobCreateCommandU5f_userId :: Maybe (UserId), yieldJobCreateCommandJobType :: YieldJobCreateCommandJobType, yieldJobCreateCommandParams :: GenerationJobParams } deriving (Eq, Show)
instance FromJSON YieldJobCreateCommand where
  parseJSON = checked "YieldJobCreateCommand" $ withObject "YieldJobCreateCommand" (\fields -> YieldJobCreateCommand <$> optional fields "_roles" <*> optional fields "_userId" <*> fields .: "jobType" <*> fields .: "params")
instance ToJSON YieldJobCreateCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_roles" (yieldJobCreateCommandU5f_roles value), optionalPair "_userId" (yieldJobCreateCommandU5f_userId value), [("jobType", toJSON (yieldJobCreateCommandJobType value))], [("params", toJSON (yieldJobCreateCommandParams value))]]))

data YieldJobCreateCommandJobType = YieldJobCreateCommandJobTypeYield deriving (Eq, Show)
instance FromJSON YieldJobCreateCommandJobType where
  parseJSON = checked "YieldJobCreateCommandJobType" $ \value -> if value == (String "yield") then pure YieldJobCreateCommandJobTypeYield else fail "unknown enumeration member"
instance ToJSON YieldJobCreateCommandJobType where
  toJSON YieldJobCreateCommandJobTypeYield = String "yield"
