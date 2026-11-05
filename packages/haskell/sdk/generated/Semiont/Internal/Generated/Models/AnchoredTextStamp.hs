-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnchoredTextStamp
  ( AnchoredTextStamp(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data AnchoredTextStamp = AnchoredTextStamp { anchoredTextStampStamp :: Text } deriving (Eq, Show)
instance FromJSON AnchoredTextStamp where
  parseJSON = checked "AnchoredTextStamp" $ withObject "AnchoredTextStamp" (\fields -> AnchoredTextStamp <$> fields .: "stamp")
instance ToJSON AnchoredTextStamp where toJSON value = Object (KM.fromList (concat [[("stamp", toJSON (anchoredTextStampStamp value))]]))

