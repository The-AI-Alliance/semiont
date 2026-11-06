{-# LANGUAGE OverloadedStrings #-}
module HttpFacts (httpFacts) where

import Control.Monad (forM, unless)
import Data.Aeson (Value(..), eitherDecodeStrict')
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Char (toUpper)
import Data.List (nub)
import qualified Data.Map.Strict as Map
import qualified Data.Text.Encoding as Encoding
import Semiont.Internal.Schema (Schemas, normalize)
import Text.Read (readMaybe)
import Data.Text (Text)
import qualified Data.Text as T
import System.FilePath ((</>), takeBaseName)

data Route = Route
  { constructorName :: Text, methodName :: Text, pathName :: Text
  , inputName :: Text, outputName :: Text, inputMedia :: Maybe Text
  , outputMedia :: Text, successCode :: Text, needsAuthentication :: Bool
  , addedSchemas :: [(Text, Value)], headerSchemas :: [(Text, Text, Value)]
  }

httpFacts :: FilePath -> Value -> Schemas -> IO ([(Text, Value)], [(FilePath, Text)])
httpFacts root (Object spec) schemas = do
  paths <- case KM.lookup "paths" spec of Just (Object paths) -> pure paths; _ -> fail "OpenAPI has no paths"
  rows <- fmap concat $ forM (KM.toList paths) $ \(path, item) -> do
    Object fields <- case item of
      Object fields | Just (String file) <- KM.lookup "$ref" fields ->
        Bytes.readFile (root </> "protocol/specs/src" </> T.unpack file) >>= either fail pure . eitherDecodeStrict'
      _ -> pure item
    unless (case KM.lookup "parameters" fields of Nothing -> True; Just (Array values) -> null values; _ -> False)
      (fail "path-level HTTP parameters need an explicit resolver")
    forM [(method, operation) | (method, Object operation) <- KM.toList fields, KM.member "operationId" operation] $ \(method, operation) -> do
      name <- case KM.lookup "operationId" operation of Just (String name) -> pure name; _ -> fail "HTTP operation has no id"
      Object responses <- maybe (fail "HTTP operation has no responses") pure (KM.lookup "responses" operation)
      let success = [(status, response) | (status, response) <- KM.toList responses, T.isPrefixOf "2" (Key.toText status)]
      (status, Object response) <- case success of [one] -> pure one; _ -> fail "HTTP operation needs one success status"
      Object content <- maybe (fail "HTTP success has no content") pure (KM.lookup "content" response)
      (media, Object answer) <- case KM.toList content of [one] -> pure one; _ -> fail "HTTP success needs one content type"
      schema <- maybe (fail "HTTP success has no schema") pure (KM.lookup "schema" answer)
      let constructor = case T.uncons name of Just (first, rest) -> T.cons (toUpper first) rest; _ -> name
      (typ, extra) <- case schema of
        Object shape | Just (String reference) <- KM.lookup "$ref" shape -> pure (T.pack (takeBaseName (T.unpack reference)), [])
        Object shape | KM.lookup "format" shape == Just (String "binary") -> pure ("ByteString", [])
        _ -> pure (constructor <> "Response", [(constructor <> "Response", schema)])
      security <- case KM.lookup "security" operation of
        Just (Array values) -> pure values
        Nothing -> case KM.lookup "security" spec of Nothing -> pure mempty; Just (Array values) -> pure values; _ -> fail "invalid root security"
        _ -> fail "invalid operation security"
      let authenticated = not (null security) && not (any (== Object mempty) security)
      (requestType, requestContentType, requestExtra) <- case KM.lookup "requestBody" operation of
        Nothing -> pure ("()", Nothing, [])
        Just (Object body) -> do
          unless (KM.lookup "required" body == Just (Bool True)) (fail "optional HTTP bodies need an explicit encoding rule")
          Object requestContent <- maybe (fail "HTTP request body has no content") pure (KM.lookup "content" body)
          (requestMedia, Object requestDescription) <- case KM.toList requestContent of [one] -> pure one; _ -> fail "HTTP body needs one content type"
          requestSchema <- maybe (fail "HTTP body has no schema") pure (KM.lookup "schema" requestDescription)
          case requestSchema of
            Object shape | Just (String reference) <- KM.lookup "$ref" shape -> do
              unless (all (`elem` ["$ref", "description", "$comment"]) (KM.keys shape)) (fail "constrained HTTP body reference needs a model")
              pure (T.pack (takeBaseName (T.unpack reference)), Just (Key.toText requestMedia), [])
            _ -> pure (constructor <> "Request", Just (Key.toText requestMedia), [(constructor <> "Request", requestSchema)])
        _ -> fail "HTTP body references need an explicit resolver"
      parameters <- case KM.lookup "parameters" operation of Nothing -> pure []; Just (Array values) -> pure (foldr (:) [] values); _ -> fail "HTTP parameters are not an array"
      headers <- fmap concat $ forM (zip [0 :: Int ..] parameters) $ \(index, parameter) -> case parameter of
        Object parameterFields | KM.member "$ref" parameterFields -> fail "HTTP parameter references need a resolver"
        Object parameterFields | KM.lookup "in" parameterFields == Just (String "header"), KM.lookup "required" parameterFields == Just (Bool True) -> do
          headerName <- case KM.lookup "name" parameterFields of Just (String value) -> pure value; _ -> fail "HTTP header has no name"
          shape <- maybe (fail "HTTP header has no schema") pure (KM.lookup "schema" parameterFields)
          pure [(headerName, constructor <> "Header" <> T.pack (show index), shape)]
        Object _ -> pure []
        _ -> fail "HTTP parameter is not an object"
      pure Route
        { constructorName = constructor, methodName = T.toUpper (Key.toText method), pathName = Key.toText path
        , inputName = requestType, outputName = typ, inputMedia = requestContentType
        , outputMedia = Key.toText media, successCode = Key.toText status, needsAuthentication = authenticated
        , addedSchemas = extra ++ requestExtra, headerSchemas = headers
        }
  unless (length rows == length (nub (map constructorName rows))) (fail "HTTP constructor collision")
  authority <- Encoding.decodeUtf8 <$> Bytes.readFile (root </> "packages/typescript/http-transport/src/transport/api-error.ts")
  let section = snd (T.breakOn "export function refusesCredential(status: number, body: unknown): boolean {" authority)
      statements = T.words (fst (T.breakOn "\n}" (T.dropWhile (/= '{') section)))
  (unauthorized, limited, field, constant) <- case statements of
    ["{", "return", "status", "===", one, "||", "(status", "===", two, "&&", "isObject(body)", "&&", member, "===", symbol] -> do
      first <- maybe (fail "unreadable credential status") pure (readMaybe (T.unpack one) :: Maybe Int)
      second <- maybe (fail "unreadable credential limit status") pure (readMaybe (T.unpack two) :: Maybe Int)
      property <- maybe (fail "unreadable credential body field") pure (T.stripPrefix "body['" member >>= T.stripSuffix "']")
      name <- maybe (fail "unreadable credential constant") pure (T.stripSuffix ");" symbol)
      pure (first, second, property, name)
    _ -> fail "credential refusal reference changed; update the Haskell derivation"
  literal <- case [T.takeWhile (/= '\'') value | line <- T.lines authority, Just value <- [T.stripPrefix ("const " <> constant <> " = '") line]] of
    [value] | not (T.null value) -> pure value
    _ -> fail "unreadable credential refusal constant"
  let lookupSchema name = maybe (fail ("missing HTTP schema: " ++ T.unpack name)) pure (Map.lookup name schemas)
      members (Object value) = pure value
      members _ = fail "HTTP schema is not an object"
      property name value = members value >>= \fields -> maybe (fail ("HTTP schema has no requested field: " ++ T.unpack (Key.toText name))) pure (KM.lookup name fields)
  limit <- lookupSchema "LimitRefusal" >>= either fail pure . normalize schemas
  refusalCode <- property "properties" limit >>= property (Key.fromText field) >>= either fail pure . normalize schemas
  codeType <- property "type" refusalCode
  codeChoices <- property "enum" refusalCode
  unless (codeType == String "string" && case codeChoices of Array values -> String literal `elem` values; _ -> False)
    (fail "credential refusal reader no longer matches its schema")
  pattern <- lookupSchema "PersistedEventId" >>= property "pattern"
  (prefix, separator) <- case pattern of
    String value | Just body <- T.stripPrefix "^" value >>= T.stripSuffix "[0-9]+$" ->
      case T.splitOn ".+" body of [before, after] | not (T.null before) && not (T.null after) -> pure (before, after); _ -> fail "persisted id grammar changed"
    _ -> fail "persisted id grammar changed"
  event <- lookupSchema "BusEventMessage" >>= property "properties" >>= property "event" >>= property "enum"
  eventName <- case event of Array values | [String value] <- foldr (:) [] values -> pure value; _ -> fail "bus event has no single name"
  let quote = T.pack . show . T.unpack
      code = T.unlines
        [ "-- Generated from protocol/specs/src/openapi.json and its paths, and the reference credential classifier. Do not edit."
        , "{-# LANGUAGE GADTs, OverloadedStrings #-}"
        , "module Semiont.Http.Routes (HttpRoute(..), routeName, routeMethod, routePath, routeStatus, routeMediaType, routeAuthenticated, routeRequestMediaType, routeRequiredHeaders, wireRefusesCredential, persistedScopePrefix, busEventName) where"
        , "import Data.ByteString (ByteString)"
        , "import Data.Text (Text)"
        , "import Data.Aeson (Value(..))"
        , "import qualified Data.Aeson.KeyMap as KM"
        , "import Semiont.Types"
        , "data HttpRoute request answer where"
        ] <> T.unlines ["  " <> constructorName row <> " :: HttpRoute " <> inputName row <> " " <> outputName row | row <- rows]
        <> "routeName :: HttpRoute request answer -> Text\n" <> T.unlines ["routeName " <> constructorName row <> " = " <> quote (constructorName row) | row <- rows]
        <> "routeMethod :: HttpRoute request answer -> ByteString\n" <> T.unlines ["routeMethod " <> constructorName row <> " = " <> quote (methodName row) | row <- rows]
        <> "routePath :: HttpRoute request answer -> Text\n" <> T.unlines ["routePath " <> constructorName row <> " = " <> quote (pathName row) | row <- rows]
        <> "routeStatus :: HttpRoute request answer -> Int\n" <> T.unlines ["routeStatus " <> constructorName row <> " = " <> successCode row | row <- rows]
        <> "routeMediaType :: HttpRoute request answer -> ByteString\n" <> T.unlines ["routeMediaType " <> constructorName row <> " = " <> quote (outputMedia row) | row <- rows]
        <> "routeRequestMediaType :: HttpRoute request answer -> Maybe ByteString\n" <> T.unlines ["routeRequestMediaType " <> constructorName row <> " = " <> maybe "Nothing" (("Just " <>) . quote) (inputMedia row) | row <- rows]
        <> "routeAuthenticated :: HttpRoute request answer -> Bool\n" <> T.unlines ["routeAuthenticated " <> constructorName row <> " = " <> if needsAuthentication row then "True" else "False" | row <- rows]
        <> "routeRequiredHeaders :: HttpRoute request answer -> [(ByteString, Text)]\n" <> T.unlines ["routeRequiredHeaders " <> constructorName row <> " = [" <> T.intercalate ", " ["(" <> quote header <> ", " <> quote named <> ")" | (header,named,_) <- headerSchemas row] <> "]" | row <- rows]
        <> "wireRefusesCredential :: Int -> Maybe Value -> Bool\nwireRefusesCredential status body = status == " <> T.pack (show unauthorized)
        <> " || (status == " <> T.pack (show limited) <> " && maybe False matches body)\n  where matches (Object fields) = KM.lookup " <> quote field <> " fields == Just (String " <> quote literal <> ")\n        matches _ = False\n"
        <> "persistedScopePrefix :: ResourceId -> Text\npersistedScopePrefix scope = " <> quote prefix <> " <> resourceIdValue scope <> " <> quote separator <> "\n"
        <> "busEventName :: Text\nbusEventName = " <> quote eventName <> "\n"
  pure (concat [addedSchemas row ++ [(named, shape) | (_,named,shape) <- headerSchemas row] | row <- rows], [("src/Semiont/Http/Routes.hs", code)])
httpFacts _ _ _ = fail "OpenAPI is not an object"
