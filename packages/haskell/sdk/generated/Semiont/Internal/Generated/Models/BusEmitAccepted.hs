-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BusEmitAccepted
  ( BusEmitAccepted(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data BusEmitAccepted = BusEmitAccepted { busEmitAcceptedSubscribers :: Maybe (Integer), busEmitAcceptedAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BusEmitAccepted where
  parseJSON = checked "BusEmitAccepted" $ withObject "BusEmitAccepted" (\fields -> BusEmitAccepted <$> optional fields "subscribers" <*> traverse parseJSON (withoutFields ["subscribers"] fields))
instance ToJSON BusEmitAccepted where toJSON value = Object (KM.fromList (concat [optionalPair "subscribers" (busEmitAcceptedSubscribers value)]) <> fmap toJSON (withoutFields ["subscribers"] (busEmitAcceptedAdditionalProperties value)))
