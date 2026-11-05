-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.Selector
  ( Selector(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
import Semiont.Internal.Generated.Models.FragmentSelector
import Semiont.Internal.Generated.Models.SvgSelector
import Semiont.Internal.Generated.Models.TextPositionSelector
import Semiont.Internal.Generated.Models.TextQuoteSelector
data Selector = SelectorBranch1 (TextPositionSelector) | SelectorBranch2 (TextQuoteSelector) | SelectorBranch3 (SvgSelector) | SelectorBranch4 (FragmentSelector) deriving (Eq, Show)
instance FromJSON Selector where
  parseJSON = checked "Selector" $ \value -> (SelectorBranch1 <$> parseJSON value) <|> (SelectorBranch2 <$> parseJSON value) <|> (SelectorBranch3 <$> parseJSON value) <|> (SelectorBranch4 <$> parseJSON value)
instance ToJSON Selector where
  toJSON (SelectorBranch1 value) = toJSON value
  toJSON (SelectorBranch2 value) = toJSON value
  toJSON (SelectorBranch3 value) = toJSON value
  toJSON (SelectorBranch4 value) = toJSON value


