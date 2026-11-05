-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.YieldUpdateOk
  ( YieldUpdateOk(..)
  , YieldUpdateOkResponse(..)
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
data YieldUpdateOk = YieldUpdateOk { yieldUpdateOkResponse :: YieldUpdateOkResponse, yieldUpdateOkAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON YieldUpdateOk where
  parseJSON = checked "YieldUpdateOk" $ withObject "YieldUpdateOk" (\fields -> YieldUpdateOk <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON YieldUpdateOk where toJSON value = Object (KM.fromList (concat [[("response", toJSON (yieldUpdateOkResponse value))]]) <> fmap toJSON (withoutFields ["response"] (yieldUpdateOkAdditionalProperties value)))

data YieldUpdateOkResponse = YieldUpdateOkResponse { yieldUpdateOkResponseResourceId :: ResourceId, yieldUpdateOkResponseAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON YieldUpdateOkResponse where
  parseJSON = checked "YieldUpdateOkResponse" $ withObject "YieldUpdateOkResponse" (\fields -> YieldUpdateOkResponse <$> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["resourceId"] fields))
instance ToJSON YieldUpdateOkResponse where toJSON value = Object (KM.fromList (concat [[("resourceId", toJSON (yieldUpdateOkResponseResourceId value))]]) <> fmap toJSON (withoutFields ["resourceId"] (yieldUpdateOkResponseAdditionalProperties value)))

