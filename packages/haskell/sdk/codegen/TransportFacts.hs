{-# LANGUAGE OverloadedStrings #-}

module TransportFacts (transportFacts) where

import Control.Monad (forM, unless)
import Data.Aeson (Value(..))
import qualified Data.Aeson.KeyMap as KM
import qualified Data.Aeson.Key as Key
import qualified Data.ByteString as Bytes
import Data.Char (toUpper)
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as T
import Data.Text.Encoding (decodeUtf8)
import qualified Data.Vector as V
import System.FilePath ((</>))

between :: Text -> Text -> Text -> Either String Text
between start end source = do
  let (_, rest) = T.breakOn start source
  unless (not (T.null rest)) (Left ("missing transport authority marker: " ++ T.unpack start))
  let (body, trailing) = T.breakOn end (T.drop (T.length start) rest)
  unless (not (T.null trailing)) (Left "unterminated transport authority section")
  unless (T.count start body == 0 && T.count start (T.drop (T.length end) trailing) == 0)
    (Left "ambiguous transport authority section")
  pure body

constructor :: Text -> Text
constructor value = case T.uncons value of Nothing -> value; Just (first, rest) -> T.cons (toUpper first) rest

transportFacts :: FilePath -> Value -> Value -> IO (Value, [(FilePath, Text)])
transportFacts root registry identifiers = do
  eventBus <- decodeUtf8 <$> Bytes.readFile (root </> "packages/typescript/core/src/event-bus.ts")
  contract <- decodeUtf8 <$> Bytes.readFile (root </> "protocol/contract/TRANSPORT-HTTP.md")
  either (ioError . userError) pure $ do
    carrier <- between "export interface TraceCarrier {\n" "\n}" eventBus
    fields <- forM (filter (\line -> not (T.null line) && not (any (`T.isPrefixOf` line) ["/*", "*", "//"])) (map T.strip (T.lines carrier))) $ \line -> do
      unless (T.isPrefixOf "readonly " line) (Left "unsupported TraceCarrier member")
      let (key, rest) = T.breakOn ":" (T.drop (T.length "readonly ") line)
          optional = T.isSuffixOf "?" key
          named = if optional then T.dropEnd 1 key else key
      unless (T.strip rest == ": string;") (Left "unsupported TraceCarrier property type")
      pure (named, optional)
    unless (not (null fields)) (Left "empty TraceCarrier interface")
    let schema = Object (KM.fromList
          [("type", String "object"), ("additionalProperties", Bool False)
          , ("properties", Object (KM.fromList [(Key.fromText key, Object (KM.singleton "type" (String "string"))) | (key, _) <- fields]))
          , ("required", Array (V.fromList [String key | (key, False) <- fields]))])
    section <- between "### Connection lifecycle\n" "### Reconnect discipline" contract
    graph <- between "```\n" "\n```" section
    edges <- forM (filter (not . T.null) (map T.strip (T.lines graph))) $ \line -> do
      let (source, right) = T.breakOn "→" line
      unless (not (T.null right)) (Left "invalid connection-state graph row")
      let targets = T.strip (T.drop 1 right)
      pure (T.strip source, if targets == "(terminal)" then [] else map T.strip (T.splitOn "|" targets))
    let states = map fst edges
    unless (Set.size (Set.fromList states) == length states && not (null states)) (Left "duplicate or missing connection states")
    unless (all (`elem` states) (concatMap snd edges)) (Left "connection graph names an unknown state")
    traceField <- case registry of
      Object object -> case KM.lookup "trace" object of
        Just (Object trace) -> case KM.lookup "field" trace of Just (String value) -> Right value; _ -> Left "missing trace field"
        _ -> Left "missing registry trace facts"
      _ -> Left "invalid registry"
    userField <- case identifiers of
      Object object -> case KM.lookup "kinds" object of
        Just (Array kinds) -> case [field | Object kind <- V.toList kinds, KM.lookup "schema" kind == Just (String "UserId")
          , Just (Array properties) <- [KM.lookup "properties" kind], String field <- V.toList properties, T.isPrefixOf "_" field] of
            [field] -> Right field
            _ -> Left "UserId needs exactly one authenticated stamp property"
        _ -> Left "missing identifier kinds"
      _ -> Left "invalid identifier kinds"
    let quote = T.pack . show . T.unpack
        code = T.unlines
          [ "-- Generated from TRANSPORT-HTTP.md, bus/registry.json and identifiers/kinds.json. Do not edit."
          , "{-# LANGUAGE OverloadedStrings #-}"
          , "module Semiont.Transport.Facts (ConnectionState(..), connectionStateName, connectionTransitions, traceField, userField) where"
          , "import Data.Text (Text)"
          , "data ConnectionState = " <> T.intercalate " | " (map constructor states) <> " deriving (Eq, Ord, Show, Enum, Bounded)"
          , "connectionStateName :: ConnectionState -> Text"
          ] <> T.unlines ["connectionStateName " <> constructor value <> " = " <> quote value | value <- states]
            <> "connectionTransitions :: ConnectionState -> [ConnectionState]\n"
            <> T.unlines ["connectionTransitions " <> constructor source <> " = [" <> T.intercalate ", " (map constructor targets) <> "]" | (source, targets) <- edges]
            <> "traceField :: Text\ntraceField = " <> quote traceField <> "\nuserField :: Text\nuserField = " <> quote userField <> "\n"
    pure (schema, [("src/Semiont/Transport/Facts.hs", code)])
