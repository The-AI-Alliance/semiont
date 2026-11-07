-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.TextualBody
  ( TextualBody(..)
  , TextualBodyType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.BodyPurpose
data TextualBody = TextualBody { textualBodyFormat :: Maybe (Text), textualBodyLanguage :: Maybe (Text), textualBodyPurpose :: Maybe (BodyPurpose), textualBodyType :: TextualBodyType, textualBodyValue :: Text, textualBodyAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON TextualBody where
  parseJSON = checked "TextualBody" $ withObject "TextualBody" (\fields -> TextualBody <$> optional fields "format" <*> optional fields "language" <*> optional fields "purpose" <*> fields .: "type" <*> fields .: "value" <*> traverse parseJSON (withoutFields ["format", "language", "purpose", "type", "value"] fields))
instance ToJSON TextualBody where toJSON value = Object (KM.fromList (concat [optionalPair "format" (textualBodyFormat value), optionalPair "language" (textualBodyLanguage value), optionalPair "purpose" (textualBodyPurpose value), [("type", toJSON (textualBodyType value))], [("value", toJSON (textualBodyValue value))]]) <> fmap toJSON (withoutFields ["format", "language", "purpose", "type", "value"] (textualBodyAdditionalProperties value)))

data TextualBodyType = TextualBodyTypeTextualBody deriving (Eq, Show)
instance FromJSON TextualBodyType where
  parseJSON = checked "TextualBodyType" $ \value -> if value == (String "TextualBody") then pure TextualBodyTypeTextualBody else fail "unknown enumeration member"
instance ToJSON TextualBodyType where
  toJSON TextualBodyTypeTextualBody = String "TextualBody"
