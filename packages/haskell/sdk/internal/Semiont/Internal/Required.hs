{-# LANGUAGE OverloadedStrings #-}

module Semiont.Internal.Required (missingRequired) where

import Control.Applicative ((<|>))
import Data.Aeson (Value(..))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.Foldable (toList)
import Data.List (nub)
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Vector as V
import Semiont.Internal.Schema (Schemas, normalize)

missingRequired :: Schemas -> Text -> Value -> Maybe Text
missingRequired schemas named value = Map.lookup named schemas >>= walk [] value
  where
    at path = T.intercalate "." path
    first = foldr (<|>) Nothing
    walk path actual original = case normalize schemas original of
      Left _ -> Nothing
      Right (Object fields) -> case KM.lookup "$ref" fields of
        Just (String reference) -> Map.lookup (T.dropEnd 5 (T.takeWhileEnd (/= '/') reference)) schemas >>= walk path actual
        _ -> case KM.lookup "oneOf" fields <|> KM.lookup "anyOf" fields of
          Just (Array branches) -> case nub (map (walk path actual) (toList branches)) of [one] -> one; _ -> Nothing
          _ -> case actual of
            Object object ->
              let required = case KM.lookup "required" fields of Just (Array keys) -> [key | String key <- toList keys]; _ -> []
                  properties = case KM.lookup "properties" fields of Just (Object members) -> members; _ -> KM.empty
                  absent = [at (path ++ [key]) | key <- required, not (KM.member (Key.fromText key) object)]
                  nested = [walk (path ++ [Key.toText key]) member schema | (key, member) <- KM.toList object, Just schema <- [KM.lookup key properties]]
              in case absent of key : _ -> Just key; [] -> first nested
            Array members -> case KM.lookup "items" fields of
              Just item -> first [walk (path ++ [T.pack (show index)]) member item | (index, member) <- zip [0 :: Int ..] (V.toList members)]
              Nothing -> Nothing
            _ -> Nothing
      Right _ -> Nothing
