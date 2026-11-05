{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Control.Applicative ((<|>))
import Control.Monad (forM_, unless)
import Data.Aeson (Value(..), eitherDecodeStrict')
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Either (isLeft)
import Data.Foldable (toList)
import Data.IORef (modifyIORef', newIORef, readIORef)
import Data.List (isSuffixOf)
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Vector as V
import Semiont.Internal.Generated.RoundTrip (roundTrip)
import Semiont.Internal.Generated.Schemas (schemas)
import Semiont.Internal.Schema (checkSchema, normalize, validate, validateNamed)
import System.Directory (doesDirectoryExist, listDirectory)
import System.Environment (getArgs)
import System.FilePath ((</>), takeBaseName)
import Runtime (runtimeCases)

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))

readJSON :: FilePath -> IO Value
readJSON path = Bytes.readFile path >>= either (ioError . userError) pure . eitherDecodeStrict'

object :: Value -> KM.KeyMap Value
object (Object fields) = fields
object _ = KM.empty

array :: Value -> [Value]
array (Array values) = toList values
array _ = []

at :: Key.Key -> Value -> Value
at key value = maybe Null id (KM.lookup key (object value))

sample :: Int -> Value -> Either String Value
sample depth original
  | depth > 40 = Left "required schema recursion exceeds sample budget"
  | otherwise = do
      normalized <- normalize schemas original
      let fields = object normalized
          nested = sample (depth + 1)
          choose candidates = case filter (either (const False) (const True) . validate schemas normalized) candidates of
            value : _ -> Right value
            [] -> Left ("no valid generated sample for " ++ show normalized)
      case KM.lookup "$ref" fields of
        Just (String reference) -> case Map.lookup (T.pack (takeBaseName (T.unpack reference))) schemas of
          Just target -> nested target
          Nothing -> Left "sample reference has no schema"
        _ -> case KM.lookup "enum" fields of
          Just (Array values) -> choose (toList values)
          _ -> case KM.lookup "oneOf" fields <|> KM.lookup "anyOf" fields of
            Just (Array alternatives) -> choose [value | Right value <- map nested (toList alternatives)]
            _ -> case KM.lookup "type" fields of
              Just (String "string") -> do
                let width = case KM.lookup "minLength" fields of Just (Number n) -> ceiling n; _ -> 0
                choose [String text | text <- [T.replicate width "a", "a", "did:example:probe", "e-a", "e-a:b:c", "p-a-1", T.replicate 64 "a"]]
              Just (String "integer") -> choose [Number (case KM.lookup "minimum" fields of Just (Number n) -> fromInteger (ceiling n); _ -> 0)]
              Just (String "number") -> choose [Number (case KM.lookup "minimum" fields of Just (Number n) -> n; _ -> 0)]
              Just (String "boolean") -> Right (Bool False)
              Just (String "array") -> do
                let size = case KM.lookup "minItems" fields of Just (Number n) -> ceiling n; _ -> 0
                items <- mapM (const (nested (at "items" normalized))) [1 :: Int .. size]
                choose [Array (V.fromList items)]
              Just (String "object") -> do
                let properties = object (at "properties" normalized)
                required <- mapM (\key -> case key of
                  String name -> do
                    let member = Key.fromText name
                    definition <- maybe (Left "required field has no schema") Right (KM.lookup member properties)
                    (,) member <$> nested definition
                  _ -> Left "required name is not a string") (array (at "required" normalized))
                choose [Object (KM.fromList required)]
              Nothing -> Right Null
              _ -> Left "sample shape unsupported"

expectRoundTrip :: Text -> Value -> IO ()
expectRoundTrip name value = case roundTrip name value of
  Left reason -> ioError (userError (T.unpack name ++ ": " ++ reason))
  Right encoded -> require (T.unpack name ++ " lost JSON members: " ++ show value ++ " -> " ++ show encoded) (encoded == value)

schemaCases :: FilePath -> IO ()
schemaCases root = do
  files <- listDirectory (root </> "protocol/specs/src/components/schemas")
  forM_ [T.pack (takeBaseName file) | file <- files, ".json" `isSuffixOf` file] $ \name ->
    require ("missing generated schema: " ++ T.unpack name) (Map.member name schemas)
  forM_ (Map.toAscList schemas) $ \(name, definition) -> do
    value <- either (ioError . userError . ((T.unpack name ++ ": ") ++)) pure (sample 0 definition)
    expectRoundTrip name value
    normalized <- either (ioError . userError) pure (normalize schemas definition)
    let properties = object (at "properties" normalized)
        required = array (at "required" normalized)
    forM_ (KM.toList properties) $ \(key, field) -> do
      if at "nullable" field /= Bool True then pure () else do
        expectRoundTrip name (Object (KM.insert key Null (object value)))
        if String (Key.toText key) `elem` required then pure ()
          else expectRoundTrip name (Object (KM.delete key (object value)))
    case value of
      Object fields | at "type" normalized == String "object" && at "additionalProperties" normalized /= Bool False && at "maxProperties" normalized == Null -> do
        extra <- case at "additionalProperties" normalized of
          typed@(Object _) -> either (ioError . userError) pure (sample 0 typed)
          _ -> pure (Number 18446744073709551617)
        expectRoundTrip name (Object (KM.insert "__haskell_probe" extra fields))
      _ -> pure ()
    case at "enum" normalized of
      Array values -> do
        mapM_ (expectRoundTrip name) values
        let unknown candidate = if String candidate `V.elem` values then unknown (candidate <> "_") else candidate
        require (T.unpack name ++ " accepted an unknown enum member") (isLeft (roundTrip name (String (unknown "__haskell_unknown"))))
      _ -> pure ()

identifierCases :: FilePath -> IO ()
identifierCases root = do
  kinds <- readJSON (root </> "protocol/specs/src/identifiers/kinds.json")
  forM_ (array (at "kinds" kinds)) $ \kind -> case at "schema" kind of
    String name -> do
      forM_ (array (at "accepts" kind)) $ \entry -> expectRoundTrip name (at "id" entry)
      forM_ (array (at "refuses" kind)) $ \entry ->
        require (T.unpack name ++ " accepted " ++ show (at "id" entry)) (isLeft (roundTrip name (at "id" entry)))
    _ -> ioError (userError "identifier table has no schema name")

filesUnder :: FilePath -> IO [FilePath]
filesUnder directory = do
  names <- listDirectory directory
  fmap concat $ mapM (\name -> do
    let path = directory </> name
    nested <- doesDirectoryExist path
    if nested then filesUnder path else pure [path | ".json" `isSuffixOf` name]) names

corpusCases :: FilePath -> IO ()
corpusCases root = do
  registry <- readJSON (root </> "protocol/specs/src/bus/registry.json")
  let channels = Map.fromList [(name, channel) | channel <- array (at "channels" registry), String name <- [at "channel" channel]]
  held <- newIORef (0 :: Int)
  refused <- newIORef (0 :: Int)
  let resolve names value = case value of
        Object fields -> case KM.lookup "$var" fields of
          Just (String key) -> KM.lookup (Key.fromText key) names
          _ -> case KM.lookup "$join" fields of
            Just (Array parts) -> String . T.concat <$> traverse (\part -> case resolve names part of Just (String text) -> Just text; _ -> Nothing) (toList parts)
            _ -> Object <$> traverse (resolve names) fields
        Array values -> Array <$> traverse (resolve names) values
        String "_" -> Nothing
        _ -> Just value
      walk names value = case value of
        Object fields -> do
          let bindings = KM.mapMaybe (resolve names) (object (at "let" value))
              current = bindings <> names
          case (KM.lookup "channel" fields, KM.lookup "payload" fields) of
            (Just (String channel), Just raw) -> case (Map.lookup channel channels, resolve current raw) of
              (Just channelSchema, Just resolved) -> do
                let shape = at "shape" channelSchema
                    payload = if shape == String "envelope" then at "response" resolved else resolved
                    named = at (if shape == String "storedEvent" then "payload" else "schema") channelSchema
                case named of
                  String name | payload /= Null -> case validateNamed schemas name payload of
                    Left _ -> do
                      require "decoder accepted a schema-invalid corpus payload" (isLeft (roundTrip name payload))
                      modifyIORef' refused (+ 1)
                    Right () -> expectRoundTrip name payload >> modifyIORef' held (+ 1)
                  _ -> pure ()
              _ -> pure ()
            _ -> pure ()
          foldWalk current (map snd (KM.toList fields))
        Array values -> foldWalk names (toList values)
        _ -> pure names
      foldWalk names [] = pure names
      foldWalk names (value : rest) = walk names value >>= \next -> foldWalk next rest
  forM_ ["sdk/wire", "sdk/live", "worker"] $ \part -> do
    files <- filesUnder (root </> "protocol/conformance" </> part)
    forM_ files $ \path -> do
      value <- readJSON path
      let initial = KM.fromList [(Key.fromText key, String key) | key <- ["r1", "r2", "r3", "a1", "a2"]]
            <> KM.fromList [(Key.fromText key, String ("did:web:example.org:users:" <> key)) | key <- ["client", "participant"]]
      _ <- walk initial value
      pure ()
  count <- readIORef held
  failures <- readIORef refused
  require "corpus runner executed no payloads" (count > 0)
  putStrLn ("PASS corpus payloads: " ++ show count ++ " round-trips; " ++ show failures ++ " schema-invalid refusals")

main :: IO ()
main = do
  args <- getArgs
  root <- case args of [value] -> pure value; _ -> ioError (userError "expected repository root")
  runtimeCases
  require "unknown schema keyword accepted" (isLeft (checkSchema schemas (Object (KM.singleton "not" (Object KM.empty)))))
  require "malformed schema bound accepted" (isLeft (checkSchema schemas (Object (KM.fromList [("type", String "string"), ("minLength", String "one")]))))
  require "unsupported regex escape accepted" (isLeft (checkSchema schemas (Object (KM.fromList [("type", String "string"), ("pattern", String "^\\d+$")]))))
  let noSpace = Object (KM.fromList [("type", String "string"), ("pattern", String "^\\S+$")])
      dot = Object (KM.fromList [("type", String "string"), ("pattern", String "^x.+z$")])
  forM_ ["\xa0", "\x2028", "\xfeff"] $ \separator ->
    require "ECMAScript whitespace accepted by non-space pattern" (isLeft (validate schemas noSpace (String ("x" <> separator))))
  forM_ ["\n", "\r", "\x2028", "\x2029"] $ \separator ->
    require "ECMAScript dot matched line terminator" (isLeft (validate schemas dot (String ("x" <> separator <> "z"))))
  schemaCases root
  putStrLn "PASS generated schema samples, null presence, open members, exact numbers and enums"
  identifierCases root
  putStrLn "PASS shared identifier acceptance/refusal cases"
  corpusCases root
