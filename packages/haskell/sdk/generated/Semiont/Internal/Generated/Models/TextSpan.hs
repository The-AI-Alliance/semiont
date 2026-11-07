-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.TextSpan
  ( TextSpan(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data TextSpan = TextSpan { textSpanEnd :: Scientific, textSpanExact :: Text, textSpanPrefix :: Maybe (Text), textSpanStart :: Scientific, textSpanSuffix :: Maybe (Text), textSpanAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON TextSpan where
  parseJSON = checked "TextSpan" $ withObject "TextSpan" (\fields -> TextSpan <$> fields .: "end" <*> fields .: "exact" <*> optional fields "prefix" <*> fields .: "start" <*> optional fields "suffix" <*> traverse parseJSON (withoutFields ["end", "exact", "prefix", "start", "suffix"] fields))
instance ToJSON TextSpan where toJSON value = Object (KM.fromList (concat [[("end", toJSON (textSpanEnd value))], [("exact", toJSON (textSpanExact value))], optionalPair "prefix" (textSpanPrefix value), [("start", toJSON (textSpanStart value))], optionalPair "suffix" (textSpanSuffix value)]) <> fmap toJSON (withoutFields ["end", "exact", "prefix", "start", "suffix"] (textSpanAdditionalProperties value)))
