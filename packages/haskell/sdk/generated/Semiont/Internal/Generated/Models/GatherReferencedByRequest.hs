-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GatherReferencedByRequest
  ( GatherReferencedByRequest(..)
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
data GatherReferencedByRequest = GatherReferencedByRequest { gatherReferencedByRequestMotivation :: Maybe (Motivation), gatherReferencedByRequestResourceId :: ResourceId, gatherReferencedByRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatherReferencedByRequest where
  parseJSON = checked "GatherReferencedByRequest" $ withObject "GatherReferencedByRequest" (\fields -> GatherReferencedByRequest <$> optional fields "motivation" <*> fields .: "resourceId" <*> traverse parseJSON (withoutFields ["motivation", "resourceId"] fields))
instance ToJSON GatherReferencedByRequest where toJSON value = Object (KM.fromList (concat [optionalPair "motivation" (gatherReferencedByRequestMotivation value), [("resourceId", toJSON (gatherReferencedByRequestResourceId value))]]) <> fmap toJSON (withoutFields ["motivation", "resourceId"] (gatherReferencedByRequestAdditionalProperties value)))
