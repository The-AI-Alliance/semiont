-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.ResourceErrorEvent
  ( ResourceErrorEvent(..)
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
data ResourceErrorEvent = ResourceErrorEvent { resourceErrorEventMessage :: Text, resourceErrorEventResourceId :: ResourceId, resourceErrorEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON ResourceErrorEvent where
  parseJSON = checked "ResourceErrorEvent" $ withObject "ResourceErrorEvent" (\fields -> ResourceErrorEvent <$> fields .: "message" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["message", "resourceId"] fields))
instance ToJSON ResourceErrorEvent where toJSON value = Object (KM.fromList (concat [[("message", toJSON (resourceErrorEventMessage value))], [("resourceId", toJSON (resourceErrorEventResourceId value))]]) <> fmap toJSON (withoutFields ["message", "resourceId"] (resourceErrorEventAdditionalProperties value)))
