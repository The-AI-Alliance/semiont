-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.RepresentationNotFound
  ( RepresentationNotFound(..)
  , RepresentationNotFoundCode(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data RepresentationNotFound = RepresentationNotFound { representationNotFoundCode :: RepresentationNotFoundCode, representationNotFoundDetails :: Maybe (Value), representationNotFoundError :: Text, representationNotFoundHint :: Maybe (Text), representationNotFoundAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON RepresentationNotFound where
  parseJSON = checked "RepresentationNotFound" $ withObject "RepresentationNotFound" (\fields -> RepresentationNotFound <$> fields .: "code" <*> optional fields "details" <*> fields .: "error" <*> optional fields "hint" <*> traverse parseJSON (withoutFields ["code", "details", "error", "hint"] fields))
instance ToJSON RepresentationNotFound where toJSON value = Object (KM.fromList (concat [[("code", toJSON (representationNotFoundCode value))], optionalPair "details" (representationNotFoundDetails value), [("error", toJSON (representationNotFoundError value))], optionalPair "hint" (representationNotFoundHint value)]) <> fmap toJSON (withoutFields ["code", "details", "error", "hint"] (representationNotFoundAdditionalProperties value)))

data RepresentationNotFoundCode = RepresentationNotFoundCodeResource | RepresentationNotFoundCodeRepresentation deriving (Eq, Show)
instance FromJSON RepresentationNotFoundCode where
  parseJSON = checked "RepresentationNotFoundCode" $ \value -> if value == (String "resource") then pure RepresentationNotFoundCodeResource else if value == (String "representation") then pure RepresentationNotFoundCodeRepresentation else fail "unknown enumeration member"
instance ToJSON RepresentationNotFoundCode where
  toJSON RepresentationNotFoundCodeResource = String "resource"
  toJSON RepresentationNotFoundCodeRepresentation = String "representation"


