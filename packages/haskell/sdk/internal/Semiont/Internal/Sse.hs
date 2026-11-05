{-# LANGUAGE OverloadedStrings #-}

module Semiont.Internal.Sse (Parser, newParser, feed, Item(..), Event(..)) where

import qualified Data.ByteString as Bytes
import Data.ByteString (ByteString)
import Data.ByteString.Builder (Builder, byteString, toLazyByteString)
import qualified Data.ByteString.Lazy as Lazy
import Data.Text (Text)
import qualified Data.Text as T
import Data.Text.Encoding (decodeUtf8With)
import Data.Text.Encoding.Error (lenientDecode)

data Event = Event
  { eventType :: Text
  , assignedId :: Maybe Text
  , lastEventId :: Text
  , eventData :: Text
  } deriving (Eq, Show)

data Item = Message Event | RetryAfterMs Integer deriving (Eq, Show)

data Parser = Parser
  { line :: Builder
  , skipLF :: Bool
  , firstLine :: Bool
  , name :: Text
  , explicitId :: Maybe Text
  , rememberedId :: Text
  , dataLines :: [Text]
  }

newParser :: Parser
newParser = Parser mempty False True "" Nothing "" []

-- Retain the assigned id separately: a passing frame must not inherit an older
-- positioned frame's identity, even though SSE's Last-Event-ID buffer persists.
feed :: Parser -> ByteString -> (Parser, [Item])
feed initial bytes = consume initial bytes []
  where
    consume parser chunk items = case Bytes.uncons chunk of
      Nothing -> (parser, reverse items)
      Just (10, rest) | skipLF parser -> consume parser { skipLF = False } rest items
      _ ->
        let (part, ending) = Bytes.break (\value -> value == 10 || value == 13) chunk
            buffered = parser { line = line parser <> byteString part, skipLF = False }
        in case Bytes.uncons ending of
          Nothing -> (buffered, reverse items)
          Just (terminator, rest) ->
            let raw = decodeUtf8With lenientDecode (Lazy.toStrict (toLazyByteString (line buffered)))
                text = if firstLine buffered then maybe raw id (T.stripPrefix "\xfeff" raw) else raw
                (updated, item) = completeLine buffered { line = mempty, firstLine = False, skipLF = terminator == 13 } text
            in consume updated rest (maybe items (: items) item)

completeLine :: Parser -> Text -> (Parser, Maybe Item)
completeLine parser text
  | T.null text =
      let event = Event (if T.null (name parser) then "message" else name parser)
            (explicitId parser) (rememberedId parser) (T.intercalate "\n" (reverse (dataLines parser)))
          item = if null (dataLines parser) then Nothing else Just (Message event)
      in (parser { name = "", explicitId = Nothing, dataLines = [] }, item)
  | T.isPrefixOf ":" text = (parser, Nothing)
  | otherwise =
      let (field, suffix) = T.breakOn ":" text
          value = case T.uncons suffix of
            Nothing -> ""
            Just (_, rest) -> maybe rest id (T.stripPrefix " " rest)
      in case field of
        "event" -> (parser { name = value }, Nothing)
        "data" -> (parser { dataLines = value : dataLines parser }, Nothing)
        "id" | not (T.any (== '\0') value) -> (parser { explicitId = Just value, rememberedId = value }, Nothing)
        "retry" | not (T.null value) && T.all (\character -> character >= '0' && character <= '9') value ->
          (parser, Just (RetryAfterMs (T.foldl' (\number character -> number * 10 + fromIntegral (fromEnum character - fromEnum '0')) 0 value)))
        _ -> (parser, Nothing)
