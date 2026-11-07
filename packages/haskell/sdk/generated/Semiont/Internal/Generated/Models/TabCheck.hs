-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.TabCheck
  ( TabCheck(..)
  , TabCheckBranch1Value(..)
  , TabCheckBranch2Value(..)
  , TabCheckBranch3Value(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.TabVerdict
data TabCheck = TabCheckBranch1 (TabCheckBranch1Value) | TabCheckBranch2 (TabCheckBranch2Value) | TabCheckBranch3 (TabCheckBranch3Value) deriving (Eq, Show)
instance FromJSON TabCheck where
  parseJSON = checked "TabCheck" $ \value -> (TabCheckBranch1 <$> parseJSON value) <|> (TabCheckBranch2 <$> parseJSON value) <|> (TabCheckBranch3 <$> parseJSON value)
instance ToJSON TabCheck where
  toJSON (TabCheckBranch1 value) = toJSON value
  toJSON (TabCheckBranch2 value) = toJSON value
  toJSON (TabCheckBranch3 value) = toJSON value


data TabCheckBranch1Value = TabCheckBranch1Value { tabCheckBranch1ValueVerdict :: TabVerdict } deriving (Eq, Show)
instance FromJSON TabCheckBranch1Value where
  parseJSON = checked "TabCheckBranch1Value" $ withObject "TabCheckBranch1Value" (\fields -> TabCheckBranch1Value <$> fields .: "verdict")
instance ToJSON TabCheckBranch1Value where toJSON value = Object (KM.fromList (concat [[("verdict", toJSON (tabCheckBranch1ValueVerdict value))]]))

data TabCheckBranch2Value = TabCheckBranch2Value { tabCheckBranch2ValueMediaType :: Maybe (Text), tabCheckBranch2ValueName :: Text, tabCheckBranch2ValueVerdict :: TabVerdict } deriving (Eq, Show)
instance FromJSON TabCheckBranch2Value where
  parseJSON = checked "TabCheckBranch2Value" $ withObject "TabCheckBranch2Value" (\fields -> TabCheckBranch2Value <$> optional fields "mediaType" <*> fields .: "name" <*> fields .: "verdict")
instance ToJSON TabCheckBranch2Value where toJSON value = Object (KM.fromList (concat [optionalPair "mediaType" (tabCheckBranch2ValueMediaType value), [("name", toJSON (tabCheckBranch2ValueName value))], [("verdict", toJSON (tabCheckBranch2ValueVerdict value))]]))

data TabCheckBranch3Value = TabCheckBranch3Value { tabCheckBranch3ValueVerdict :: TabVerdict } deriving (Eq, Show)
instance FromJSON TabCheckBranch3Value where
  parseJSON = checked "TabCheckBranch3Value" $ withObject "TabCheckBranch3Value" (\fields -> TabCheckBranch3Value <$> fields .: "verdict")
instance ToJSON TabCheckBranch3Value where toJSON value = Object (KM.fromList (concat [[("verdict", toJSON (tabCheckBranch3ValueVerdict value))]]))
