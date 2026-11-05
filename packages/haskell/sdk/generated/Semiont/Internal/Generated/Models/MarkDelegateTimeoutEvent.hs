-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MarkDelegateTimeoutEvent
  ( MarkDelegateTimeoutEvent(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.Motivation
import Semiont.Internal.Generated.Models.ResourceId
data MarkDelegateTimeoutEvent = MarkDelegateTimeoutEvent { markDelegateTimeoutEventMotivation :: Motivation, markDelegateTimeoutEventResourceId :: ResourceId, markDelegateTimeoutEventAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MarkDelegateTimeoutEvent where
  parseJSON = checked "MarkDelegateTimeoutEvent" $ withObject "MarkDelegateTimeoutEvent" (\fields -> MarkDelegateTimeoutEvent <$> fields .: "motivation" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["motivation", "resourceId"] fields))
instance ToJSON MarkDelegateTimeoutEvent where toJSON value = Object (KM.fromList (concat [[("motivation", toJSON (markDelegateTimeoutEventMotivation value))], [("resourceId", toJSON (markDelegateTimeoutEventResourceId value))]]) <> fmap toJSON (withoutFields ["motivation", "resourceId"] (markDelegateTimeoutEventAdditionalProperties value)))

