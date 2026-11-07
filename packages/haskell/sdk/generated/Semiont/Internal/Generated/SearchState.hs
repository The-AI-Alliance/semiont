-- Generated from packages/typescript/sdk/src/state/lib/search-pipeline.ts; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.SearchState where
import Data.Aeson (FromJSON(..), ToJSON(..), withObject, object, (.:), (.=))
data SearchState value = SearchState { searchStateResults :: [value], searchStateIsSearching :: Bool } deriving (Eq, Show)
instance FromJSON value => FromJSON (SearchState value) where
  parseJSON = withObject "SearchState" (\fields -> SearchState <$> fields .: "results" <*> fields .: "isSearching")
instance ToJSON value => ToJSON (SearchState value) where
  toJSON state = object ["results" .= searchStateResults state, "isSearching" .= searchStateIsSearching state]
