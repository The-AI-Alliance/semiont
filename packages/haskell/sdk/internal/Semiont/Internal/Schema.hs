{-# LANGUAGE OverloadedStrings #-}

module Semiont.Internal.Schema
  ( Schemas, normalize, checkSchema, validate, validateNamed, validateProperty
  ) where

import Control.Monad (forM_, unless, when)
import Data.Aeson (Object, Value(..))
import Data.Char (GeneralCategory(Space, LineSeparator, ParagraphSeparator), generalCategory)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.Foldable (toList)
import Data.List (nub)
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import Data.Scientific (Scientific, floatingOrInteger)
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Vector as V
import Text.Regex.TDFA (Regex, defaultCompOpt, defaultExecOpt, makeRegexOptsM, matchTest, multiline)

type Schemas = Map Text Value

ensure :: Bool -> String -> Either String ()
ensure good reason = unless good (Left reason)

objectFields :: Value -> Either String Object
objectFields (Object value) = Right value
objectFields _ = Left "expected a schema object"

reference :: Schemas -> Text -> Either String Value
reference schemas name = maybe (Left ("unknown schema reference: " ++ T.unpack name)) Right
  (Map.lookup (T.dropEnd 5 (lastPart name)) schemas)
  where
    lastPart = T.takeWhileEnd (/= '/')

patternText :: Text -> Either String String
patternText = translate False . T.unpack
  where
    translate _ [] = Right []
    translate False ('\\' : 'S' : rest) = (("[^" ++ ecmaWhitespace ++ "]") ++) <$> translate False rest
    translate inside ('\\' : character : rest)
      | character `elem` ("^$.[]-+?*{}()|\\" :: String) = (['\\', character] ++) <$> translate inside rest
      | otherwise = Left ("unsupported regular-expression escape: \\" ++ [character])
    translate _ ('\\' : []) = Left "unterminated regular-expression escape"
    translate False ('[' : rest) = ('[' :) <$> translate True rest
    translate True (']' : rest) = (']' :) <$> translate False rest
    translate False ('.' : rest) = ("[^\n\r\x2028\x2029]" ++) <$> translate False rest
    translate inside (character : rest) = (character :) <$> translate inside rest

-- ECMAScript uses Unicode separator categories plus these control characters and BOM.
-- POSIX [:space:] in regex-tdfa is ASCII-only.
ecmaWhitespace :: String
ecmaWhitespace = "\t\n\v\f\r\xfeff" ++ filter
  (\character -> generalCategory character `elem` [Space, LineSeparator, ParagraphSeparator]) [minBound .. maxBound]

compilePattern :: Text -> Either String Regex
compilePattern value = do
  expression <- patternText value
  maybe (Left ("unsupported regular expression: " ++ T.unpack value)) Right
    (makeRegexOptsM defaultCompOpt { multiline = False } defaultExecOpt expression :: Maybe Regex)

-- Check every schema node before code generation; annotation values are not schemas.
checkSchema :: Schemas -> Value -> Either String ()
checkSchema schemas schema = do
  fields <- objectFields schema
  forM_ (KM.keys fields) $ \key -> ensure (Key.toText key `elem` keywords)
    ("unsupported schema keyword: " ++ show key)
  case KM.lookup "$ref" fields of
    Nothing -> pure ()
    Just (String name) -> reference schemas name >> pure ()
    Just _ -> Left "$ref is not a string"
  case KM.lookup "type" fields of
    Nothing -> pure ()
    Just (String name) -> ensure (name `elem` ["string", "integer", "number", "boolean", "object", "array"])
      ("unsupported schema type: " ++ T.unpack name)
    Just _ -> Left "schema type is not a string"
  case KM.lookup "format" fields of
    Nothing -> pure ()
    Just (String name) -> ensure (name `elem` ["uri", "date-time", "binary"]) ("unsupported format: " ++ T.unpack name)
    Just _ -> Left "format is not a string"
  case KM.lookup "pattern" fields of
    Nothing -> pure ()
    Just (String expression) -> compilePattern expression >> pure ()
    Just _ -> Left "pattern is not a string"
  forM_ ["minimum", "maximum"] $ \key -> case KM.lookup key fields of
    Nothing -> pure ()
    Just (Number _) -> pure ()
    Just _ -> Left (show key ++ " must be a number")
  forM_ ["minLength", "maxLength", "minItems", "maxItems", "maxProperties"] $ \key -> case KM.lookup key fields of
    Nothing -> pure ()
    Just (Number number) -> case floatingOrInteger number :: Either Double Integer of
      Right count -> ensure (count >= 0) (show key ++ " must be non-negative")
      Left _ -> Left (show key ++ " must be a whole number")
    Just _ -> Left (show key ++ " must be a whole number")
  forM_ ["nullable", "uniqueItems", "deprecated", "readOnly", "writeOnly"] $ \key -> case KM.lookup key fields of
    Nothing -> pure ()
    Just (Bool _) -> pure ()
    Just _ -> Left (show key ++ " must be a boolean")
  case KM.lookup "required" fields of
    Nothing -> pure ()
    Just (Array names) -> forM_ names $ \name -> case name of String _ -> pure (); _ -> Left "required must contain strings"
    Just _ -> Left "required must be an array"
  case KM.lookup "enum" fields of
    Nothing -> pure ()
    Just (Array values) -> ensure (not (V.null values) && length (nub (toList values)) == V.length values) "enum must be non-empty and unique"
    Just _ -> Left "enum must be an array"
  case KM.lookup "properties" fields of
    Nothing -> pure ()
    Just (Object properties) -> mapM_ (checkSchema schemas) properties
    Just _ -> Left "properties is not an object"
  forM_ ["items", "additionalProperties"] $ \key -> case KM.lookup key fields of
    Nothing -> pure ()
    Just (Bool _) | key == "additionalProperties" -> pure ()
    Just value -> checkSchema schemas value
  forM_ ["allOf", "oneOf", "anyOf"] $ \key -> case KM.lookup key fields of
    Nothing -> pure ()
    Just (Array values) -> ensure (not (V.null values)) "empty union/intersection" >> mapM_ (checkSchema schemas) values
    Just _ -> Left "union/intersection is not an array"
  where
    keywords = ["$ref", "$comment", "type", "description", "title", "properties", "required", "additionalProperties"
      , "items", "enum", "oneOf", "anyOf", "allOf", "format", "nullable", "pattern", "minimum", "maximum"
      , "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "maxProperties", "default", "example"
      , "examples", "discriminator", "deprecated", "readOnly", "writeOnly"]

-- OpenAPI's object extensions describe one merged object, including its closed fields.
normalize :: Schemas -> Value -> Either String Value
normalize schemas = expand []
  where
    expand trail value = do
      fields <- objectFields value
      case KM.lookup "allOf" fields of
        Just (Array parts) -> do
          objects <- traverse (part trail) (toList parts)
          merged <- foldl merge (Right KM.empty) objects
          Object <$> merge (Right merged) (KM.delete "allOf" fields)
        _ -> Right value
    part trail value = do
      fields <- objectFields value
      case KM.lookup "$ref" fields of
        Just (String name) -> do
          ensure (name `notElem` trail) ("cyclic schema intersection: " ++ T.unpack name)
          target <- reference schemas name
          expanded <- expand (name : trail) target >>= objectFields
          merge (Right expanded) (KM.delete "$ref" fields)
        _ -> expand trail value >>= objectFields
    merge previous next = previous >>= \old -> foldl add (Right old) (KM.toList next)
    add previous (key, value) = do
      old <- previous
      combined <- case (key, KM.lookup key old, value) of
        ("properties", Just (Object left), Object right) -> Right (Object (KM.unionWith intersection left right))
        ("required", Just (Array left), Array right) -> Right (Array (V.fromList (nub (toList left ++ toList right))))
        ("enum", Just (Array left), Array right) -> do
          let common = V.filter (`V.elem` right) left
          ensure (not (V.null common)) "empty enum intersection"
          Right (Array common)
        ("minimum", Just (Number left), Number right) -> Right (Number (max left right))
        ("maximum", Just (Number left), Number right) -> Right (Number (min left right))
        (bound, Just (Number left), Number right) | bound `elem` ["minLength", "minItems"] -> Right (Number (max left right))
        (bound, Just (Number left), Number right) | bound `elem` ["maxLength", "maxItems", "maxProperties"] -> Right (Number (min left right))
        ("type", Just left, right) -> ensure (left == right) "incompatible intersection types" >> Right right
        ("additionalProperties", Just (Bool False), _) -> Right (Bool False)
        ("uniqueItems", Just (Bool True), _) -> Right (Bool True)
        (constrained, Just left, right) | constrained `elem` ["pattern", "oneOf", "anyOf", "items", "$ref"] ->
          ensure (left == right) ("unsupported intersection of " ++ show constrained) >> Right right
        _ -> Right value
      pure (KM.insert key combined old)
    intersection left right
      | left == right = left
      | otherwise = Object (KM.singleton "allOf" (Array (V.fromList [left, right])))

validateNamed :: Schemas -> Text -> Value -> Either String ()
validateNamed schemas name value = case Map.lookup name schemas of
  Nothing -> Left ("unknown schema: " ++ T.unpack name)
  Just schema -> validate schemas schema value

validateProperty :: Schemas -> Text -> Key.Key -> Value -> Either String ()
validateProperty schemas named key value = do
  schema <- maybe (Left "unknown enclosing schema") Right (Map.lookup named schemas)
  fields <- normalize schemas schema >>= objectFields
  properties <- maybe (Left "schema declares no properties") objectFields (KM.lookup "properties" fields)
  member <- maybe (Left "schema does not declare this property") Right (KM.lookup key properties)
  validate schemas member value

validate :: Schemas -> Value -> Value -> Either String ()
validate schemas original value = do
  schema <- normalize schemas original >>= objectFields
  if value == Null && KM.lookup "nullable" schema == Just (Bool True) then pure () else do
    case KM.lookup "$ref" schema of
      Just (String name) -> reference schemas name >>= \target -> validate schemas target value
      _ -> pure ()
    case KM.lookup "enum" schema of
      Just (Array values) -> ensure (value `V.elem` values) "unknown enumeration member"
      _ -> pure ()
    forM_ ["oneOf", "anyOf"] $ \key -> case KM.lookup key schema of
      Just (Array alternatives) -> do
        let accepted = V.length (V.filter (\branch -> either (const False) (const True) (validate schemas branch value)) alternatives)
        ensure (if key == "oneOf" then accepted == 1 else accepted > 0)
          (T.unpack (Key.toText key) ++ " rejected value (matched " ++ show accepted ++ " branches)")
      _ -> pure ()
    case KM.lookup "type" schema of
      Just (String "string") -> case value of
        String text -> do
          lengthBounds schema "minLength" "maxLength" (T.length text)
          case KM.lookup "pattern" schema of
            Just (String expression) -> do
              patternValue <- compilePattern expression
              ensure (matchTest patternValue (T.unpack text)) "string does not match pattern"
            _ -> pure ()
        _ -> Left "expected string"
      Just (String "integer") -> case value of
        Number number -> case floatingOrInteger number :: Either Double Integer of
          Left _ -> Left "expected integer"
          Right _ -> numberBounds schema number
        _ -> Left "expected integer"
      Just (String "number") -> case value of
        Number number -> numberBounds schema number
        _ -> Left "expected number"
      Just (String "boolean") -> case value of Bool _ -> pure (); _ -> Left "expected boolean"
      Just (String "array") -> case value of
        Array items -> do
          lengthBounds schema "minItems" "maxItems" (V.length items)
          when (KM.lookup "uniqueItems" schema == Just (Bool True))
            (ensure (length (nub (toList items)) == V.length items) "duplicate array item")
          case KM.lookup "items" schema of
            Just itemSchema -> mapM_ (validate schemas itemSchema) items
            Nothing -> Left "array schema has no items"
        _ -> Left "expected array"
      Just (String "object") -> case value of
        Object fields -> do
          lengthBounds schema "minProperties" "maxProperties" (KM.size fields)
          let properties = case KM.lookup "properties" schema of Just (Object p) -> p; _ -> KM.empty
          case KM.lookup "required" schema of
            Just (Array required) -> forM_ required $ \key -> case key of
              String name -> ensure (KM.member (Key.fromText name) fields) ("missing required field: " ++ T.unpack name)
              _ -> Left "required field is not a string"
            _ -> pure ()
          forM_ (KM.toList fields) $ \(key, member) -> case KM.lookup key properties of
            Just fieldSchema -> either (Left . ((show key ++ ": ") ++)) Right (validate schemas fieldSchema member)
            Nothing -> case KM.lookup "additionalProperties" schema of
              Just (Bool False) -> Left ("unknown object field: " ++ show key)
              Just extra@(Object _) -> validate schemas extra member
              _ -> pure ()
        _ -> Left "expected object"
      Nothing -> pure ()
      _ -> Left "unsupported schema type"

lengthBounds :: Object -> Key.Key -> Key.Key -> Int -> Either String ()
lengthBounds schema low high size = do
  case KM.lookup low schema of Just (Number bound) -> ensure (fromIntegral size >= bound) "value is too short"; _ -> pure ()
  case KM.lookup high schema of Just (Number bound) -> ensure (fromIntegral size <= bound) "value is too long"; _ -> pure ()

numberBounds :: Object -> Scientific -> Either String ()
numberBounds schema number = do
  case KM.lookup "minimum" schema of Just (Number bound) -> ensure (number >= bound) "number below minimum"; _ -> pure ()
  case KM.lookup "maximum" schema of Just (Number bound) -> ensure (number <= bound) "number above maximum"; _ -> pure ()
