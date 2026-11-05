-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.GatherResourceComplete
  ( GatherResourceComplete(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.GatheredContext
import Semiont.Internal.Generated.Models.ResourceId
data GatherResourceComplete = GatherResourceComplete { gatherResourceCompleteResourceId :: ResourceId, gatherResourceCompleteResponse :: GatheredContext, gatherResourceCompleteAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON GatherResourceComplete where
  parseJSON = checked "GatherResourceComplete" $ withObject "GatherResourceComplete" (\fields -> GatherResourceComplete <$> fields .: "resourceId" <*> fields .: "response" <*> traverse parseJSON (withoutFields ["resourceId", "response"] fields))
instance ToJSON GatherResourceComplete where toJSON value = Object (KM.fromList (concat [[("resourceId", toJSON (gatherResourceCompleteResourceId value))], [("response", toJSON (gatherResourceCompleteResponse value))]]) <> fmap toJSON (withoutFields ["resourceId", "response"] (gatherResourceCompleteAdditionalProperties value)))

