-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BodyOperationRemove
  ( BodyOperationRemove(..)
  , BodyOperationRemoveItem(..)
  , BodyOperationRemoveOp(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.SpecificResource
import Semiont.Internal.Generated.Models.TextualBody
data BodyOperationRemove = BodyOperationRemove { bodyOperationRemoveItem :: BodyOperationRemoveItem, bodyOperationRemoveOp :: BodyOperationRemoveOp, bodyOperationRemoveAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BodyOperationRemove where
  parseJSON = checked "BodyOperationRemove" $ withObject "BodyOperationRemove" (\fields -> BodyOperationRemove <$> fields .: "item" <*> fields .: "op" <*> traverse parseJSON (withoutFields ["item", "op"] fields))
instance ToJSON BodyOperationRemove where toJSON value = Object (KM.fromList (concat [[("item", toJSON (bodyOperationRemoveItem value))], [("op", toJSON (bodyOperationRemoveOp value))]]) <> fmap toJSON (withoutFields ["item", "op"] (bodyOperationRemoveAdditionalProperties value)))

data BodyOperationRemoveItem = BodyOperationRemoveItemBranch1 (TextualBody) | BodyOperationRemoveItemBranch2 (SpecificResource) deriving (Eq, Show)
instance FromJSON BodyOperationRemoveItem where
  parseJSON = checked "BodyOperationRemoveItem" $ \value -> (BodyOperationRemoveItemBranch1 <$> parseJSON value) <|> (BodyOperationRemoveItemBranch2 <$> parseJSON value)
instance ToJSON BodyOperationRemoveItem where
  toJSON (BodyOperationRemoveItemBranch1 value) = toJSON value
  toJSON (BodyOperationRemoveItemBranch2 value) = toJSON value


data BodyOperationRemoveOp = BodyOperationRemoveOpRemove deriving (Eq, Show)
instance FromJSON BodyOperationRemoveOp where
  parseJSON = checked "BodyOperationRemoveOp" $ \value -> if value == (String "remove") then pure BodyOperationRemoveOpRemove else fail "unknown enumeration member"
instance ToJSON BodyOperationRemoveOp where
  toJSON BodyOperationRemoveOpRemove = String "remove"
