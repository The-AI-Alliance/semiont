-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.KbTarget
  ( KbTarget(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.KbEndpoint
data KbTarget = KbTarget { kbTargetEndpoint :: KbEndpoint, kbTargetId :: Text, kbTargetLabel :: Text, kbTargetAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON KbTarget where
  parseJSON = checked "KbTarget" $ withObject "KbTarget" (\fields -> KbTarget <$> fields .: "endpoint" <*> fields .: "id" <*> fields .: "label" <*> traverse parseJSON (withoutFields ["endpoint", "id", "label"] fields))
instance ToJSON KbTarget where toJSON value = Object (KM.fromList (concat [[("endpoint", toJSON (kbTargetEndpoint value))], [("id", toJSON (kbTargetId value))], [("label", toJSON (kbTargetLabel value))]]) <> fmap toJSON (withoutFields ["endpoint", "id", "label"] (kbTargetAdditionalProperties value)))

