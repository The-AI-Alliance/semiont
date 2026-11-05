{-# LANGUAGE OverloadedStrings #-}

module Semiont.Internal.Codec
  ( checked, optional, presence, optionalPair, presencePair, withoutFields
  ) where

import Data.Aeson (FromJSON(..), ToJSON(..), Object, Value)
import qualified Data.Aeson as JSON
import Data.Aeson.Key (Key)
import qualified Data.Aeson.KeyMap as KM
import Data.Aeson.Types (Parser)
import Data.Text (Text)
import Semiont.Internal.Generated.Schemas (schemas)
import Semiont.Internal.Schema (validateNamed)
import Semiont.Types.Presence (Presence(..))

checked :: Text -> (Value -> Parser value) -> Value -> Parser value
checked name parser value = either fail pure (validateNamed schemas name value) >> parser value

optional :: FromJSON value => Object -> Key -> Parser (Maybe value)
optional fields key = traverse parseJSON (KM.lookup key fields)

presence :: FromJSON value => Object -> Key -> Parser (Presence value)
presence fields key = case KM.lookup key fields of
  Nothing -> pure Absent
  Just JSON.Null -> pure Null
  Just value -> Present <$> parseJSON value

optionalPair :: ToJSON value => Key -> Maybe value -> [(Key, Value)]
optionalPair key = maybe [] (\value -> [(key, toJSON value)])

presencePair :: ToJSON value => Key -> Presence value -> [(Key, Value)]
presencePair _ Absent = []
presencePair key Null = [(key, JSON.Null)]
presencePair key (Present value) = [(key, toJSON value)]

withoutFields :: [Key] -> KM.KeyMap value -> KM.KeyMap value
withoutFields names = KM.filterWithKey (\key _ -> key `notElem` names)
