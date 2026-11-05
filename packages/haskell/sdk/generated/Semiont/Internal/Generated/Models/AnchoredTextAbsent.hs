-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.AnchoredTextAbsent
  ( AnchoredTextAbsent(..)
  , AnchoredTextAbsentKind(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data AnchoredTextAbsent = AnchoredTextAbsent { anchoredTextAbsentKind :: AnchoredTextAbsentKind, anchoredTextAbsentAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON AnchoredTextAbsent where
  parseJSON = checked "AnchoredTextAbsent" $ withObject "AnchoredTextAbsent" (\fields -> AnchoredTextAbsent <$> fields .: "kind" <*> traverse parseJSON (withoutFields ["kind"] fields))
instance ToJSON AnchoredTextAbsent where toJSON value = Object (KM.fromList (concat [[("kind", toJSON (anchoredTextAbsentKind value))]]) <> fmap toJSON (withoutFields ["kind"] (anchoredTextAbsentAdditionalProperties value)))

data AnchoredTextAbsentKind = AnchoredTextAbsentKindNotU2d_yet | AnchoredTextAbsentKindNoU2d_map | AnchoredTextAbsentKindUnknown deriving (Eq, Show)
instance FromJSON AnchoredTextAbsentKind where
  parseJSON = checked "AnchoredTextAbsentKind" $ \value -> if value == (String "not-yet") then pure AnchoredTextAbsentKindNotU2d_yet else if value == (String "no-map") then pure AnchoredTextAbsentKindNoU2d_map else if value == (String "unknown") then pure AnchoredTextAbsentKindUnknown else fail "unknown enumeration member"
instance ToJSON AnchoredTextAbsentKind where
  toJSON AnchoredTextAbsentKindNotU2d_yet = String "not-yet"
  toJSON AnchoredTextAbsentKindNoU2d_map = String "no-map"
  toJSON AnchoredTextAbsentKindUnknown = String "unknown"


