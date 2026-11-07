-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.YieldCloneResourceRequest
  ( YieldCloneResourceRequest(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data YieldCloneResourceRequest = YieldCloneResourceRequest { yieldCloneResourceRequestToken :: Text, yieldCloneResourceRequestAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON YieldCloneResourceRequest where
  parseJSON = checked "YieldCloneResourceRequest" $ withObject "YieldCloneResourceRequest" (\fields -> YieldCloneResourceRequest <$> fields .: "token" <*> traverse parseJSON (withoutFields ["token"] fields))
instance ToJSON YieldCloneResourceRequest where toJSON value = Object (KM.fromList (concat [[("token", toJSON (yieldCloneResourceRequestToken value))]]) <> fmap toJSON (withoutFields ["token"] (yieldCloneResourceRequestAdditionalProperties value)))
