-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MarkJobCreateCommand
  ( MarkJobCreateCommand(..)
  , MarkJobCreateCommandJobType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.MarkJobParams
import Semiont.Internal.Generated.Models.ResourceId
import Semiont.Internal.Generated.Models.UserId
data MarkJobCreateCommand = MarkJobCreateCommand { markJobCreateCommandU5f_roles :: Maybe ([Text]), markJobCreateCommandU5f_userId :: Maybe (UserId), markJobCreateCommandJobType :: MarkJobCreateCommandJobType, markJobCreateCommandParams :: MarkJobParams, markJobCreateCommandResourceId :: ResourceId } deriving (Eq, Show)
instance FromJSON MarkJobCreateCommand where
  parseJSON = checked "MarkJobCreateCommand" $ withObject "MarkJobCreateCommand" (\fields -> MarkJobCreateCommand <$> optional fields "_roles" <*> optional fields "_userId" <*> fields .: "jobType" <*> fields .: "params" <*> fields .: "resourceId")
instance ToJSON MarkJobCreateCommand where toJSON value = Object (KM.fromList (concat [optionalPair "_roles" (markJobCreateCommandU5f_roles value), optionalPair "_userId" (markJobCreateCommandU5f_userId value), [("jobType", toJSON (markJobCreateCommandJobType value))], [("params", toJSON (markJobCreateCommandParams value))], [("resourceId", toJSON (markJobCreateCommandResourceId value))]]))

data MarkJobCreateCommandJobType = MarkJobCreateCommandJobTypeMark deriving (Eq, Show)
instance FromJSON MarkJobCreateCommandJobType where
  parseJSON = checked "MarkJobCreateCommandJobType" $ \value -> if value == (String "mark") then pure MarkJobCreateCommandJobTypeMark else fail "unknown enumeration member"
instance ToJSON MarkJobCreateCommandJobType where
  toJSON MarkJobCreateCommandJobTypeMark = String "mark"


