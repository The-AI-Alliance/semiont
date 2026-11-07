{-# LANGUAGE OverloadedStrings #-}
module TextCases (textCases) where

import Control.Exception (try)
import Control.Monad (forM_, unless)
import Data.Aeson (Value(..), FromJSON, Result(..), eitherDecodeStrict', fromJSON, toJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Char (digitToInt)
import Data.Foldable (toList)
import Data.Text (Text)
import qualified Data.Text as Text
import Semiont.Errors (TransportError(..))
import qualified Semiont.MediaTypes as Media
import qualified Semiont.Resources as Resources
import System.FilePath ((</>))

member :: Text -> Value -> Value
member name (Object fields) = maybe (error ("missing text case member " ++ Text.unpack name)) id (KM.lookup (Key.fromText name) fields)
member _ _ = error "text case is not an object"
array :: Value -> [Value]
array (Array values) = toList values
array _ = error "text case list is not an array"
readValue :: FromJSON value => Value -> IO value
readValue value = case fromJSON value of Error message -> ioError (userError message); Success parsed -> pure parsed
require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))
hex :: Text -> Bytes.ByteString
hex = Bytes.pack . map (\digits -> case Text.unpack digits of [high,low] -> fromIntegral (digitToInt high*16+digitToInt low); _ -> error "invalid text case byte") . Text.words
readTable :: FilePath -> FilePath -> IO Value
readTable root name = Bytes.readFile (root </> "protocol/specs/src" </> name) >>= either (ioError . userError) pure . eitherDecodeStrict'

textCases :: FilePath -> IO ()
textCases root = do
  media <- readTable root "media-types/cases.json"
  forM_ (array (member "cloneFormat" media)) $ \row -> do
    source <- readValue (member "source" row)
    require "clone format differs from registry" (toJSON (Media.cloneFormat source) == member "format" row)
  forM_ (array (member "storageFileName" media)) $ \row -> do
    name <- readValue (member "name" row)
    format <- readValue (member "format" row)
    file <- either (ioError . userError . Text.unpack) pure (Media.storageFileName name format)
    require "storage filename differs from registry" (toJSON file == member "fileName" row)
  forM_ (array (member "textSource" media)) $ \row -> do
    format <- readValue (member "format" row)
    require "text source differs from registry" (toJSON (Media.textSourceOf format) == member "textSource" row)
    require "geometry capability differs from registry" (toJSON (Media.yieldsGeometry format) == member "yieldsGeometry" row)
    require "derived-text capability differs from registry" (toJSON (Media.derivesTextOf format) == member "derivesText" row)
  table <- readTable root "text/decode-cases.json"
  forM_ (array (member "cases" table)) $ \row -> do
    mediaType <- readValue (member "contentType" row)
    bytes <- hex <$> readValue (member "bytes" row)
    outcome <- try (Resources.decodeRepresentation bytes mediaType) :: IO (Either TransportError Text)
    case row of
      Object fields -> case KM.lookup "refused" fields of
        Just expected -> do
          label <- readValue expected
          require ("text refusal differs: " ++ show row ++ " got " ++ show outcome)
            (either (Text.isInfixOf label . transportErrorMessage) (const False) outcome)
        Nothing -> require ("decoded text differs: " ++ show row ++ " got " ++ show outcome)
          (either (const False) ((==member "text" row) . toJSON) outcome)
      _ -> ioError (userError "decode case is not an object")
  encodings <- readTable root "text/encoding-cases.json"
  forM_ (array (member "cases" encodings)) $ \row -> do
    encoding <- readValue (member "encoding" row) :: IO Text
    let fields = case row of Object entries -> entries; _ -> error "encoding case is not an object"
        fullBytes = Bytes.pack [0..255]
    forM_ (array (member "labels" row)) $ \labelValue -> do
      label <- readValue labelValue
      let mediaType = "text/plain; charset="<>label
      case KM.lookup "everyByte" fields of
        Just expected -> do
          actual <- Resources.decodeRepresentation fullBytes mediaType
          require ("single-byte mapping differs: " ++ Text.unpack encoding) (toJSON actual == expected)
        Nothing | KM.lookup "refused" fields == Just (Bool True) -> do
          outcome <- try (Resources.decodeRepresentation Bytes.empty mediaType) :: IO (Either TransportError Text)
          require "a refused standard label was accepted" (either (const True) (const False) outcome)
        Nothing -> do
          bytes <- hex <$> readValue (member "bytes" row)
          actual <- Resources.decodeRepresentation bytes mediaType
          require ("encoding label differs: " ++ Text.unpack label ++ " got " ++ show actual) (toJSON actual == member "text" row)
  putStrLn "PASS every media capability, MIME decoding, encoding label and single-byte code point case"
