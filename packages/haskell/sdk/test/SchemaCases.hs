{-# LANGUAGE OverloadedStrings #-}

module SchemaCases (schemaCases) where

import Control.Monad (forM_, unless)
import Data.Aeson (Value(..), object, toJSON, (.=))
import Data.Either (isLeft)
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import Semiont.Internal.Schema

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))

schemaCases :: IO ()
schemaCases = do
  let text = object ["type" .= String "string"]
      definitions = Map.fromList [("Text", text), ("Cycle", object ["allOf" .= [ref "Cycle"]])]
      checked = checkSchema definitions
      malformed label shape = require label (isLeft (checked shape))
      accepted label shape = require label (checked shape == Right ())
      holds shape value = require ("valid schema/value refused: " ++ show (shape, value)) (validate definitions shape value == Right ())
      refuses shape value = require ("invalid schema/value accepted: " ++ show (shape, value)) (isLeft (validate definitions shape value))
  accepted "empty schema refused" (object [])
  malformed "non-object schema accepted" Null
  malformed "unknown reference accepted" (ref "Missing")
  accepted "reference refused" (ref "Text")
  malformed "non-string reference accepted" (object ["$ref" .= True])
  malformed "unknown keyword accepted" (object ["not" .= text])
  malformed "unknown type accepted" (object ["type" .= String "unknown"])
  malformed "non-string type accepted" (object ["type" .= True])
  forM_ ["string", "integer", "number", "boolean", "object", "array"] $ \kind ->
    accepted "known type refused" (object ["type" .= String kind])
  forM_ ["uri", "date-time", "binary"] $ \format -> accepted "known format refused" (object ["format" .= String format])
  malformed "unknown format accepted" (object ["format" .= String "unknown"])
  malformed "non-string format accepted" (object ["format" .= True])
  forM_ ["^x+$", "^[a-z\\-]+$", "^\\S+$", "^x.z$"] $ \pattern ->
    accepted "supported pattern refused" (object ["pattern" .= String pattern])
  forM_ ["\\d", "\\", "["] $ \pattern -> malformed "unsupported pattern accepted" (object ["pattern" .= String pattern])
  malformed "non-string pattern accepted" (object ["pattern" .= False])
  forM_ ["minimum", "maximum"] $ \key -> do
    accepted "numeric bound refused" (object [key .= (1.5 :: Double)])
    malformed "non-numeric bound accepted" (object [key .= True])
  forM_ ["minLength", "maxLength", "minItems", "maxItems", "maxProperties"] $ \key -> do
    accepted "whole non-negative bound refused" (object [key .= (1 :: Int)])
    forM_ [Number (-1), Number 0.5, Bool True] $ \value -> malformed "invalid length bound accepted" (object [key .= value])
  forM_ ["nullable", "uniqueItems", "deprecated", "readOnly", "writeOnly"] $ \key -> do
    accepted "boolean annotation refused" (object [key .= True])
    malformed "non-boolean annotation accepted" (object [key .= Null])
  accepted "required list refused" (object ["required" .= [String "value"]])
  malformed "non-string required member accepted" (object ["required" .= [Bool True]])
  malformed "non-array required accepted" (object ["required" .= True])
  accepted "enum refused" (object ["enum" .= [String "a", String "b"]])
  forM_ [Array mempty, Bool True] $ \value -> malformed "invalid enum accepted" (object ["enum" .= value])
  malformed "duplicate enum accepted" (object ["enum" .= [String "a", String "a"]])
  accepted "nested properties refused" (object ["properties" .= object ["value" .= text]])
  malformed "non-object properties accepted" (object ["properties" .= True])
  accepted "array items refused" (object ["items" .= text])
  forM_ [Bool True, Bool False, text] $ \extra -> accepted "additional properties refused" (object ["additionalProperties" .= extra])
  forM_ ["allOf", "oneOf", "anyOf"] $ \key -> do
    accepted "schema branches refused" (object [key .= [text]])
    malformed "empty branches accepted" (object [key .= ([] :: [Value])])
    malformed "non-array branches accepted" (object [key .= True])

  holds (ref "Text") (String "a")
  refuses (ref "Text") (Bool True)
  refuses (ref "Missing") (String "a")
  holds (object []) Null
  holds (object ["type" .= String "string", "nullable" .= True]) Null
  refuses text Null
  forM_ [Bool True, Number 1, object [], Array mempty] (refuses text)
  let boundedText = object ["type" .= String "string", "minLength" .= (1 :: Int), "maxLength" .= (2 :: Int)]
  mapM_ (holds boundedText . String) ["a", "a\x1f600"]
  mapM_ (refuses boundedText . String) ["", "abc"]
  let integer = object ["type" .= String "integer", "minimum" .= (1 :: Int), "maximum" .= (2 :: Int)]
      number = object ["type" .= String "number", "minimum" .= (1 :: Int), "maximum" .= (2 :: Int)]
  mapM_ (holds integer . Number) [1, 2]
  mapM_ (refuses integer) [Number 0, Number 3, Number 1.5, Bool True]
  holds number (Number 1.5)
  mapM_ (refuses number) [Number 0.5, Number 2.5, Bool True]
  holds (object ["type" .= String "boolean"]) (Bool True)
  refuses (object ["type" .= String "boolean"]) (Number 1)
  let sequenceOf = object ["type" .= String "array", "items" .= text, "minItems" .= (1 :: Int), "maxItems" .= (2 :: Int), "uniqueItems" .= True]
  holds sequenceOf (toArray [String "a", String "b"])
  mapM_ (refuses sequenceOf) [toArray [], toArray [String "a", String "b", String "c"], toArray [String "a", String "a"], toArray [Bool True], Null]
  refuses (object ["type" .= String "array"]) (toArray [String "a"])
  let record = object ["type" .= String "object", "properties" .= object ["a" .= text], "required" .= [String "a"], "additionalProperties" .= False]
  holds record (object ["a" .= String "value"])
  mapM_ (refuses record) [object [], object ["a" .= True], object ["a" .= String "v", "extra" .= True], Null]
  holds (object ["type" .= String "object"]) (object ["extra" .= True])
  let dictionary = object ["type" .= String "object", "additionalProperties" .= text]
  holds dictionary (object ["a" .= String "value"])
  refuses dictionary (object ["a" .= True])
  refuses (object ["type" .= String "object", "maxProperties" .= (0 :: Int)]) (object ["a" .= True])
  forM_ ["oneOf", "anyOf"] $ \key -> do
    let union = object [key .= [text, object ["type" .= String "boolean"]]]
    holds union (String "a")
    holds union (Bool True)
    refuses union (Number 1)
  refuses (object ["oneOf" .= [text, text]]) (String "a")
  holds (object ["anyOf" .= [text, text]]) (String "a")
  holds (object ["type" .= String "string", "pattern" .= String "^a+$"]) (String "a")
  refuses (object ["type" .= String "string", "pattern" .= String "^a+$"]) (String "b")
  refuses (object ["enum" .= [String "a"]]) (String "b")

  let merge left right = normalize definitions (object ["allOf" .= [left, right]])
      merged label left right expected = require label (merge left right == Right expected)
  merged "intersection retained no fields" (ref "Text") text text
  forM_ [("minimum", 2), ("maximum", 1), ("minLength", 2), ("maxLength", 1), ("minItems", 2), ("maxItems", 1), ("maxProperties", 1)] $ \(key, expected) ->
    merged "intersection chose weaker bound" (object [key .= (1 :: Int)]) (object [key .= (2 :: Int)]) (object [key .= (expected :: Int)])
  merged "enum intersection broadened choices" (object ["enum" .= [String "a", String "b"]]) (object ["enum" .= [String "b", String "c"]]) (object ["enum" .= [String "b"]])
  merged "closed object reopened" (object ["additionalProperties" .= False]) (object ["additionalProperties" .= True]) (object ["additionalProperties" .= False])
  merged "uniqueness lost" (object ["uniqueItems" .= True]) (object ["uniqueItems" .= False]) (object ["uniqueItems" .= True])
  merged "required members lost or duplicated" (object ["required" .= [String "a"]]) (object ["required" .= [String "b", String "a"]]) (object ["required" .= [String "a", String "b"]])
  forM_ ["pattern", "oneOf", "anyOf", "items"] $ \key -> do
    let one = object [key .= String "a"]
    merged "identical constraint refused" one one one
    require "incompatible constraint merged" (isLeft (merge one (object [key .= String "b"])))
  require "incompatible types merged" (isLeft (merge text (object ["type" .= String "boolean"])))
  require "empty enum intersection accepted" (isLeft (merge (object ["enum" .= [String "a"]]) (object ["enum" .= [String "b"]])))
  require "cyclic intersection accepted" (isLeft (normalize definitions (object ["allOf" .= [ref "Cycle"]])))
  let left = object ["type" .= String "object", "properties" .= object ["a" .= text]]
      right = object ["properties" .= object ["a" .= object ["minLength" .= (2 :: Int)]]]
  normalized <- either (ioError . userError) pure (merge left right)
  holds normalized (object ["a" .= String "ab"])
  refuses normalized (object ["a" .= String "a"])
  require "unknown named schema accepted" (isLeft (validateNamed definitions "Missing" Null))
  let enclosing = Map.insert "Enclosing" record definitions
  require "declared property refused" (validateProperty enclosing "Enclosing" "a" (String "value") == Right ())
  require "invalid property accepted" (isLeft (validateProperty enclosing "Enclosing" "a" (Bool True)))
  require "absent enclosing schema accepted" (isLeft (validateProperty enclosing "Missing" "a" Null))
  require "absent property accepted" (isLeft (validateProperty enclosing "Enclosing" "missing" Null))
  require "propertyless schema accepted" (isLeft (validateProperty enclosing "Text" "a" Null))
  putStrLn "PASS schema refusal boundaries, intersections, unions and Unicode lengths"
  where
    ref :: Text -> Value
    ref name = object ["$ref" .= (name <> ".json")]
    toArray :: [Value] -> Value
    toArray = toJSON
