-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.BindBodyOperation
  ( BindBodyOperation(..)
  , BindBodyOperationOp(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.AnnotationBody
data BindBodyOperation = BindBodyOperation { bindBodyOperationItem :: Maybe (AnnotationBody), bindBodyOperationNewItem :: Maybe (AnnotationBody), bindBodyOperationOldItem :: Maybe (AnnotationBody), bindBodyOperationOp :: BindBodyOperationOp, bindBodyOperationAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON BindBodyOperation where
  parseJSON = checked "BindBodyOperation" $ withObject "BindBodyOperation" (\fields -> BindBodyOperation <$> optional fields "item" <*> optional fields "newItem" <*> optional fields "oldItem" <*> fields .: "op" <*> traverse parseJSON (withoutFields ["item", "newItem", "oldItem", "op"] fields))
instance ToJSON BindBodyOperation where toJSON value = Object (KM.fromList (concat [optionalPair "item" (bindBodyOperationItem value), optionalPair "newItem" (bindBodyOperationNewItem value), optionalPair "oldItem" (bindBodyOperationOldItem value), [("op", toJSON (bindBodyOperationOp value))]]) <> fmap toJSON (withoutFields ["item", "newItem", "oldItem", "op"] (bindBodyOperationAdditionalProperties value)))

data BindBodyOperationOp = BindBodyOperationOpAdd | BindBodyOperationOpRemove | BindBodyOperationOpReplace deriving (Eq, Show)
instance FromJSON BindBodyOperationOp where
  parseJSON = checked "BindBodyOperationOp" $ \value -> if value == (String "add") then pure BindBodyOperationOpAdd else if value == (String "remove") then pure BindBodyOperationOpRemove else if value == (String "replace") then pure BindBodyOperationOpReplace else fail "unknown enumeration member"
instance ToJSON BindBodyOperationOp where
  toJSON BindBodyOperationOpAdd = String "add"
  toJSON BindBodyOperationOpRemove = String "remove"
  toJSON BindBodyOperationOpReplace = String "replace"
