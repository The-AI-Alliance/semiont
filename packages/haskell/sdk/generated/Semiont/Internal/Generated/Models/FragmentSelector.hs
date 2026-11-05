-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.FragmentSelector
  ( FragmentSelector(..)
  , FragmentSelectorType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data FragmentSelector = FragmentSelector { fragmentSelectorConformsTo :: Maybe (Text), fragmentSelectorType :: FragmentSelectorType, fragmentSelectorValue :: Text, fragmentSelectorAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON FragmentSelector where
  parseJSON = checked "FragmentSelector" $ withObject "FragmentSelector" (\fields -> FragmentSelector <$> optional fields "conformsTo" <*> fields .: "type" <*> fields .: "value" <*> traverse parseJSON (withoutFields ["conformsTo", "type", "value"] fields))
instance ToJSON FragmentSelector where toJSON value = Object (KM.fromList (concat [optionalPair "conformsTo" (fragmentSelectorConformsTo value), [("type", toJSON (fragmentSelectorType value))], [("value", toJSON (fragmentSelectorValue value))]]) <> fmap toJSON (withoutFields ["conformsTo", "type", "value"] (fragmentSelectorAdditionalProperties value)))

data FragmentSelectorType = FragmentSelectorTypeFragmentSelector deriving (Eq, Show)
instance FromJSON FragmentSelectorType where
  parseJSON = checked "FragmentSelectorType" $ \value -> if value == (String "FragmentSelector") then pure FragmentSelectorTypeFragmentSelector else fail "unknown enumeration member"
instance ToJSON FragmentSelectorType where
  toJSON FragmentSelectorTypeFragmentSelector = String "FragmentSelector"


