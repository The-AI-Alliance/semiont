-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.KbReadVerdict
  ( KbReadVerdict(..)
  , KbReadVerdictBranch1Value(..)
  , KbReadVerdictBranch1ValueKind(..)
  , KbReadVerdictBranch2Value(..)
  , KbReadVerdictBranch2ValueKind(..)
  , KbReadVerdictBranch3Value(..)
  , KbReadVerdictBranch3ValueKind(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data KbReadVerdict = KbReadVerdictBranch1 (KbReadVerdictBranch1Value) | KbReadVerdictBranch2 (KbReadVerdictBranch2Value) | KbReadVerdictBranch3 (KbReadVerdictBranch3Value) deriving (Eq, Show)
instance FromJSON KbReadVerdict where
  parseJSON = checked "KbReadVerdict" $ \value -> (KbReadVerdictBranch1 <$> parseJSON value) <|> (KbReadVerdictBranch2 <$> parseJSON value) <|> (KbReadVerdictBranch3 <$> parseJSON value)
instance ToJSON KbReadVerdict where
  toJSON (KbReadVerdictBranch1 value) = toJSON value
  toJSON (KbReadVerdictBranch2 value) = toJSON value
  toJSON (KbReadVerdictBranch3 value) = toJSON value


data KbReadVerdictBranch1Value = KbReadVerdictBranch1Value { kbReadVerdictBranch1ValueKind :: KbReadVerdictBranch1ValueKind, kbReadVerdictBranch1ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON KbReadVerdictBranch1Value where
  parseJSON = checked "KbReadVerdictBranch1Value" $ withObject "KbReadVerdictBranch1Value" (\fields -> KbReadVerdictBranch1Value <$> fields .: "kind" <*> traverse parseJSON (withoutFields ["kind"] fields))
instance ToJSON KbReadVerdictBranch1Value where toJSON value = Object (KM.fromList (concat [[("kind", toJSON (kbReadVerdictBranch1ValueKind value))]]) <> fmap toJSON (withoutFields ["kind"] (kbReadVerdictBranch1ValueAdditionalProperties value)))

data KbReadVerdictBranch1ValueKind = KbReadVerdictBranch1ValueKindRecorded deriving (Eq, Show)
instance FromJSON KbReadVerdictBranch1ValueKind where
  parseJSON = checked "KbReadVerdictBranch1ValueKind" $ \value -> if value == (String "recorded") then pure KbReadVerdictBranch1ValueKindRecorded else fail "unknown enumeration member"
instance ToJSON KbReadVerdictBranch1ValueKind where
  toJSON KbReadVerdictBranch1ValueKindRecorded = String "recorded"


data KbReadVerdictBranch2Value = KbReadVerdictBranch2Value { kbReadVerdictBranch2ValueKind :: KbReadVerdictBranch2ValueKind, kbReadVerdictBranch2ValueObservedDid :: Text, kbReadVerdictBranch2ValueObservedName :: Text, kbReadVerdictBranch2ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON KbReadVerdictBranch2Value where
  parseJSON = checked "KbReadVerdictBranch2Value" $ withObject "KbReadVerdictBranch2Value" (\fields -> KbReadVerdictBranch2Value <$> fields .: "kind" <*> fields .: "observedDid" <*> fields .: "observedName" <*> traverse parseJSON (withoutFields ["kind", "observedDid", "observedName"] fields))
instance ToJSON KbReadVerdictBranch2Value where toJSON value = Object (KM.fromList (concat [[("kind", toJSON (kbReadVerdictBranch2ValueKind value))], [("observedDid", toJSON (kbReadVerdictBranch2ValueObservedDid value))], [("observedName", toJSON (kbReadVerdictBranch2ValueObservedName value))]]) <> fmap toJSON (withoutFields ["kind", "observedDid", "observedName"] (kbReadVerdictBranch2ValueAdditionalProperties value)))

data KbReadVerdictBranch2ValueKind = KbReadVerdictBranch2ValueKindConflict deriving (Eq, Show)
instance FromJSON KbReadVerdictBranch2ValueKind where
  parseJSON = checked "KbReadVerdictBranch2ValueKind" $ \value -> if value == (String "conflict") then pure KbReadVerdictBranch2ValueKindConflict else fail "unknown enumeration member"
instance ToJSON KbReadVerdictBranch2ValueKind where
  toJSON KbReadVerdictBranch2ValueKindConflict = String "conflict"


data KbReadVerdictBranch3Value = KbReadVerdictBranch3Value { kbReadVerdictBranch3ValueKind :: KbReadVerdictBranch3ValueKind, kbReadVerdictBranch3ValueAdditionalProperties :: KM.KeyMap (Value) } deriving (Eq, Show)
instance FromJSON KbReadVerdictBranch3Value where
  parseJSON = checked "KbReadVerdictBranch3Value" $ withObject "KbReadVerdictBranch3Value" (\fields -> KbReadVerdictBranch3Value <$> fields .: "kind" <*> traverse parseJSON (withoutFields ["kind"] fields))
instance ToJSON KbReadVerdictBranch3Value where toJSON value = Object (KM.fromList (concat [[("kind", toJSON (kbReadVerdictBranch3ValueKind value))]]) <> fmap toJSON (withoutFields ["kind"] (kbReadVerdictBranch3ValueAdditionalProperties value)))

data KbReadVerdictBranch3ValueKind = KbReadVerdictBranch3ValueKindNoU2d_verdict deriving (Eq, Show)
instance FromJSON KbReadVerdictBranch3ValueKind where
  parseJSON = checked "KbReadVerdictBranch3ValueKind" $ \value -> if value == (String "no-verdict") then pure KbReadVerdictBranch3ValueKindNoU2d_verdict else fail "unknown enumeration member"
instance ToJSON KbReadVerdictBranch3ValueKind where
  toJSON KbReadVerdictBranch3ValueKindNoU2d_verdict = String "no-verdict"
