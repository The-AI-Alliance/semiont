-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.YieldCloneCreated
  ( YieldCloneCreated(..)
  , YieldCloneCreatedResponse(..)
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
data YieldCloneCreated = YieldCloneCreated { yieldCloneCreatedResponse :: YieldCloneCreatedResponse, yieldCloneCreatedAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON YieldCloneCreated where
  parseJSON = checked "YieldCloneCreated" $ withObject "YieldCloneCreated" (\fields -> YieldCloneCreated <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON YieldCloneCreated where toJSON value = Object (KM.fromList (concat [[("response", toJSON (yieldCloneCreatedResponse value))]]) <> fmap toJSON (withoutFields ["response"] (yieldCloneCreatedAdditionalProperties value)))

data YieldCloneCreatedResponse = YieldCloneCreatedResponse { yieldCloneCreatedResponseResourceId :: ResourceId, yieldCloneCreatedResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON YieldCloneCreatedResponse where
  parseJSON = checked "YieldCloneCreatedResponse" $ withObject "YieldCloneCreatedResponse" (\fields -> YieldCloneCreatedResponse <$> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["resourceId"] fields))
instance ToJSON YieldCloneCreatedResponse where toJSON value = Object (KM.fromList (concat [[("resourceId", toJSON (yieldCloneCreatedResponseResourceId value))]]) <> fmap toJSON (withoutFields ["resourceId"] (yieldCloneCreatedResponseAdditionalProperties value)))

