-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.TabCheck
  ( TabCheck(..)
  , TabCheckBranch1Value(..)
  , TabCheckBranch1ValueKind(..)
  , TabCheckBranch2Value(..)
  , TabCheckBranch2ValueKind(..)
  , TabCheckBranch3Value(..)
  , TabCheckBranch3ValueKind(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data TabCheck = TabCheckBranch1 (TabCheckBranch1Value) | TabCheckBranch2 (TabCheckBranch2Value) | TabCheckBranch3 (TabCheckBranch3Value) deriving (Eq, Show)
instance FromJSON TabCheck where
  parseJSON = checked "TabCheck" $ \value -> (TabCheckBranch1 <$> parseJSON value) <|> (TabCheckBranch2 <$> parseJSON value) <|> (TabCheckBranch3 <$> parseJSON value)
instance ToJSON TabCheck where
  toJSON (TabCheckBranch1 value) = toJSON value
  toJSON (TabCheckBranch2 value) = toJSON value
  toJSON (TabCheckBranch3 value) = toJSON value


data TabCheckBranch1Value = TabCheckBranch1Value { tabCheckBranch1ValueKind :: TabCheckBranch1ValueKind, tabCheckBranch1ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON TabCheckBranch1Value where
  parseJSON = checked "TabCheckBranch1Value" $ withObject "TabCheckBranch1Value" (\fields -> TabCheckBranch1Value <$> fields .: "kind" <*> traverse parseJSON (withoutFields ["kind"] fields))
instance ToJSON TabCheckBranch1Value where toJSON value = Object (KM.fromList (concat [[("kind", toJSON (tabCheckBranch1ValueKind value))]]) <> fmap toJSON (withoutFields ["kind"] (tabCheckBranch1ValueAdditionalProperties value)))

data TabCheckBranch1ValueKind = TabCheckBranch1ValueKindGone deriving (Eq, Show)
instance FromJSON TabCheckBranch1ValueKind where
  parseJSON = checked "TabCheckBranch1ValueKind" $ \value -> if value == (String "gone") then pure TabCheckBranch1ValueKindGone else fail "unknown enumeration member"
instance ToJSON TabCheckBranch1ValueKind where
  toJSON TabCheckBranch1ValueKindGone = String "gone"


data TabCheckBranch2Value = TabCheckBranch2Value { tabCheckBranch2ValueKind :: TabCheckBranch2ValueKind, tabCheckBranch2ValueMediaType :: Maybe (Text), tabCheckBranch2ValueName :: Text, tabCheckBranch2ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON TabCheckBranch2Value where
  parseJSON = checked "TabCheckBranch2Value" $ withObject "TabCheckBranch2Value" (\fields -> TabCheckBranch2Value <$> fields .: "kind" <*> optional fields "mediaType" <*> fields .: "name" <*> traverse parseJSON (withoutFields ["kind", "mediaType", "name"] fields))
instance ToJSON TabCheckBranch2Value where toJSON value = Object (KM.fromList (concat [[("kind", toJSON (tabCheckBranch2ValueKind value))], optionalPair "mediaType" (tabCheckBranch2ValueMediaType value), [("name", toJSON (tabCheckBranch2ValueName value))]]) <> fmap toJSON (withoutFields ["kind", "mediaType", "name"] (tabCheckBranch2ValueAdditionalProperties value)))

data TabCheckBranch2ValueKind = TabCheckBranch2ValueKindReady deriving (Eq, Show)
instance FromJSON TabCheckBranch2ValueKind where
  parseJSON = checked "TabCheckBranch2ValueKind" $ \value -> if value == (String "ready") then pure TabCheckBranch2ValueKindReady else fail "unknown enumeration member"
instance ToJSON TabCheckBranch2ValueKind where
  toJSON TabCheckBranch2ValueKindReady = String "ready"


data TabCheckBranch3Value = TabCheckBranch3Value { tabCheckBranch3ValueKind :: TabCheckBranch3ValueKind, tabCheckBranch3ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON TabCheckBranch3Value where
  parseJSON = checked "TabCheckBranch3Value" $ withObject "TabCheckBranch3Value" (\fields -> TabCheckBranch3Value <$> fields .: "kind" <*> traverse parseJSON (withoutFields ["kind"] fields))
instance ToJSON TabCheckBranch3Value where toJSON value = Object (KM.fromList (concat [[("kind", toJSON (tabCheckBranch3ValueKind value))]]) <> fmap toJSON (withoutFields ["kind"] (tabCheckBranch3ValueAdditionalProperties value)))

data TabCheckBranch3ValueKind = TabCheckBranch3ValueKindUnknown deriving (Eq, Show)
instance FromJSON TabCheckBranch3ValueKind where
  parseJSON = checked "TabCheckBranch3ValueKind" $ \value -> if value == (String "unknown") then pure TabCheckBranch3ValueKindUnknown else fail "unknown enumeration member"
instance ToJSON TabCheckBranch3ValueKind where
  toJSON TabCheckBranch3ValueKindUnknown = String "unknown"
