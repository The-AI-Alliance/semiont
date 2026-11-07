-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.KbReadVerdict
  ( KbReadVerdict(..)
  , KbReadVerdictBranch1Value(..)
  , KbReadVerdictBranch2Value(..)
  , KbReadVerdictBranch3Value(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.KbReadKind
data KbReadVerdict = KbReadVerdictBranch1 (KbReadVerdictBranch1Value) | KbReadVerdictBranch2 (KbReadVerdictBranch2Value) | KbReadVerdictBranch3 (KbReadVerdictBranch3Value) deriving (Eq, Show)
instance FromJSON KbReadVerdict where
  parseJSON = checked "KbReadVerdict" $ \value -> (KbReadVerdictBranch1 <$> parseJSON value) <|> (KbReadVerdictBranch2 <$> parseJSON value) <|> (KbReadVerdictBranch3 <$> parseJSON value)
instance ToJSON KbReadVerdict where
  toJSON (KbReadVerdictBranch1 value) = toJSON value
  toJSON (KbReadVerdictBranch2 value) = toJSON value
  toJSON (KbReadVerdictBranch3 value) = toJSON value


data KbReadVerdictBranch1Value = KbReadVerdictBranch1Value { kbReadVerdictBranch1ValueKind :: KbReadKind } deriving (Eq, Show)
instance FromJSON KbReadVerdictBranch1Value where
  parseJSON = checked "KbReadVerdictBranch1Value" $ withObject "KbReadVerdictBranch1Value" (\fields -> KbReadVerdictBranch1Value <$> fields .: "kind")
instance ToJSON KbReadVerdictBranch1Value where toJSON value = Object (KM.fromList (concat [[("kind", toJSON (kbReadVerdictBranch1ValueKind value))]]))

data KbReadVerdictBranch2Value = KbReadVerdictBranch2Value { kbReadVerdictBranch2ValueKind :: KbReadKind, kbReadVerdictBranch2ValueObservedDid :: Text, kbReadVerdictBranch2ValueObservedName :: Text } deriving (Eq, Show)
instance FromJSON KbReadVerdictBranch2Value where
  parseJSON = checked "KbReadVerdictBranch2Value" $ withObject "KbReadVerdictBranch2Value" (\fields -> KbReadVerdictBranch2Value <$> fields .: "kind" <*> fields .: "observedDid" <*> fields .: "observedName")
instance ToJSON KbReadVerdictBranch2Value where toJSON value = Object (KM.fromList (concat [[("kind", toJSON (kbReadVerdictBranch2ValueKind value))], [("observedDid", toJSON (kbReadVerdictBranch2ValueObservedDid value))], [("observedName", toJSON (kbReadVerdictBranch2ValueObservedName value))]]))

data KbReadVerdictBranch3Value = KbReadVerdictBranch3Value { kbReadVerdictBranch3ValueKind :: KbReadKind } deriving (Eq, Show)
instance FromJSON KbReadVerdictBranch3Value where
  parseJSON = checked "KbReadVerdictBranch3Value" $ withObject "KbReadVerdictBranch3Value" (\fields -> KbReadVerdictBranch3Value <$> fields .: "kind")
instance ToJSON KbReadVerdictBranch3Value where toJSON value = Object (KM.fromList (concat [[("kind", toJSON (kbReadVerdictBranch3ValueKind value))]]))
