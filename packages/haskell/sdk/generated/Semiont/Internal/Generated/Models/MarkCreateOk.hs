-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.MarkCreateOk
  ( MarkCreateOk(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.MarkCreateOkResponse
data MarkCreateOk = MarkCreateOk { markCreateOkResponse :: MarkCreateOkResponse, markCreateOkAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON MarkCreateOk where
  parseJSON = checked "MarkCreateOk" $ withObject "MarkCreateOk" (\fields -> MarkCreateOk <$> fields .: "response" <*> traverse parseJSON (withoutFields ["response"] fields))
instance ToJSON MarkCreateOk where toJSON value = Object (KM.fromList (concat [[("response", toJSON (markCreateOkResponse value))]]) <> fmap toJSON (withoutFields ["response"] (markCreateOkAdditionalProperties value)))

