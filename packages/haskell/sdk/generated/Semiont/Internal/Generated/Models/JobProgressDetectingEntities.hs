-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.JobProgressDetectingEntities
  ( JobProgressDetectingEntities(..)
  , JobProgressDetectingEntitiesCode(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data JobProgressDetectingEntities = JobProgressDetectingEntities { jobProgressDetectingEntitiesCode :: JobProgressDetectingEntitiesCode, jobProgressDetectingEntitiesEntityType :: Text, jobProgressDetectingEntitiesAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON JobProgressDetectingEntities where
  parseJSON = checked "JobProgressDetectingEntities" $ withObject "JobProgressDetectingEntities" (\fields -> JobProgressDetectingEntities <$> fields .: "code" <*> fields .: "entityType" <*> traverse parseJSON (withoutFields ["code", "entityType"] fields))
instance ToJSON JobProgressDetectingEntities where toJSON value = Object (KM.fromList (concat [[("code", toJSON (jobProgressDetectingEntitiesCode value))], [("entityType", toJSON (jobProgressDetectingEntitiesEntityType value))]]) <> fmap toJSON (withoutFields ["code", "entityType"] (jobProgressDetectingEntitiesAdditionalProperties value)))

data JobProgressDetectingEntitiesCode = JobProgressDetectingEntitiesCodeDetectingU2d_entities deriving (Eq, Show)
instance FromJSON JobProgressDetectingEntitiesCode where
  parseJSON = checked "JobProgressDetectingEntitiesCode" $ \value -> if value == (String "detecting-entities") then pure JobProgressDetectingEntitiesCodeDetectingU2d_entities else fail "unknown enumeration member"
instance ToJSON JobProgressDetectingEntitiesCode where
  toJSON JobProgressDetectingEntitiesCodeDetectingU2d_entities = String "detecting-entities"
