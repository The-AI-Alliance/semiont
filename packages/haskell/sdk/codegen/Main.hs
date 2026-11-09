{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Control.Monad (foldM, forM, forM_, unless, when)
import Control.Applicative ((<|>))
import Control.Monad.State.Strict (StateT, execStateT, gets, modify', lift)
import Data.Aeson (Object, Value(..), eitherDecodeStrict')
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Char (isAlphaNum, isDigit, toLower, toUpper)
import Data.Foldable (toList)
import Data.Graph (flattenSCC, stronglyConnComp)
import Data.List (nub, sort)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as T
import Data.Text.Encoding (decodeUtf8', encodeUtf8)
import qualified Data.Vector as V
import Numeric (showHex)
import Facts (generateFacts)
import HttpFacts (httpFacts)
import TransportFacts (transportFacts)
import WorkerFacts (workerFacts)
import Semiont.Internal.Schema (Schemas, checkSchema, normalize)
import System.Directory (createDirectoryIfMissing, doesDirectoryExist, doesFileExist, listDirectory, removeFile)
import System.Environment (getArgs)
import System.FilePath ((</>), normalise, takeBaseName, takeDirectory, takeExtension)

data Declaration = Declaration { declarationExport :: Text, declarationCode :: Text, declarationOwner :: Text }
data Generation = Generation
  { definitions :: Schemas
  , identifiers :: Set.Set Text
  , declarations :: Map.Map Text Declaration
  , currentOwner :: Text
  , dependencies :: Map.Map Text (Set.Set Text)
  }
type Generate = StateT Generation (Either String)

die :: String -> Generate value
die = lift . Left

literal :: Text -> Text
literal = T.pack . show . T.unpack

identifier :: Text -> Text
identifier value = case T.uncons encoded of
  Nothing -> "Value"
  Just (first, rest) -> (if isDigit first then "V" else "") <> T.cons (toUpper first) rest
  where
    encoded = T.concatMap (\character -> if isAlphaNum character && character < '\128'
      then T.singleton character else "U" <> T.pack (showHex (fromEnum character) "") <> "_") value

lower :: Text -> Text
lower value = case T.uncons value of Nothing -> value; Just (first, rest) -> T.cons (toLower first) rest

fieldsOf :: Value -> Either String Object
fieldsOf (Object fields) = Right fields
fieldsOf _ = Left "expected schema object"

textAt :: Key.Key -> Object -> Maybe Text
textAt key fields = case KM.lookup key fields of Just (String value) -> Just value; _ -> Nothing

referenceName :: Text -> Text
referenceName = T.pack . takeBaseName . T.unpack

-- A reference into a table (`#/types/Expected`, `../session/stored.json#/storedSession`) names the schema it
-- points at by that schema's title, as a reference to a component names its file.
pointedReferences :: [(Text, Object)] -> Value -> Either String Value
pointedReferences tables = rewrite
  where
    rewrite (Object fields) = Object <$> KM.traverseWithKey pointed fields
    rewrite (Array values) = Array <$> traverse rewrite values
    rewrite value = Right value
    pointed "$ref" (String reference)
      | (table, pointer) <- T.breakOn "#" reference, not (T.null pointer) = do
          start <- maybe (Left ("reference into a table not read: " ++ T.unpack reference)) Right (lookup table tables)
          target <- foldM (into reference) (Object start) (drop 1 (T.splitOn "/" (T.drop 1 pointer)))
          fields <- fieldsOf target
          title <- maybe (Left ("reference to a schema with no title: " ++ T.unpack reference)) Right (textAt "title" fields)
          Right (String (title <> ".json"))
    pointed _ value = rewrite value
    into reference (Object fields) key = maybe (Left ("reference to nothing: " ++ T.unpack reference)) Right (KM.lookup (Key.fromText key) fields)
    into reference _ _ = Left ("reference through a value that is no object: " ++ T.unpack reference)

inline :: Text -> Value -> Generate Text
inline proposed schema = do
  occupied <- gets definitions
  let unique candidate = if Map.member candidate occupied then unique (candidate <> "Inline") else candidate
      name = unique proposed
  modify' (\state -> state { definitions = Map.insert name schema (definitions state) })
  declare name schema
  pure name

typeOf :: Text -> Value -> Generate Text
typeOf proposed original = do
  raw <- lift (fieldsOf original)
  case textAt "$ref" raw of
    Just name -> do
      let target = referenceName name
      owner <- gets currentOwner
      modify' (\state -> state { dependencies = Map.insertWith Set.union owner (Set.singleton target) (dependencies state) })
      pure target
    Nothing -> case KM.lookup "allOf" raw of
      Just (Array parts) | V.length parts == 1 -> typeOf proposed (V.head parts)
      _ -> structural proposed original

structural :: Text -> Value -> Generate Text
structural proposed original = do
  schemas <- gets definitions
  schema <- lift (normalize schemas original >>= fieldsOf)
  case textAt "$ref" schema of
    Just name -> pure (referenceName name)
    Nothing | KM.member "oneOf" schema || KM.member "anyOf" schema || KM.member "enum" schema -> inline proposed original
    Nothing -> case textAt "type" schema of
      Just "string" -> pure "Text"
      Just "integer" -> pure "Integer"
      Just "number" -> pure "Scientific"
      Just "boolean" -> pure "Bool"
      Just "array" -> case KM.lookup "items" schema of
        Just item -> (\value -> "[" <> value <> "]") <$> typeOf (proposed <> "Item") item
        Nothing -> die "array schema has no items"
      Just "object" -> inline proposed original
      Nothing | KM.null (KM.filterWithKey (\key _ -> key `notElem` ["description", "$comment"]) schema) -> pure "Value"
      other -> die (T.unpack proposed ++ ": unsupported type shape " ++ show other)

instanceHead :: Text -> Text
instanceHead name = "instance FromJSON " <> name <> " where\n  parseJSON = checked " <> literal name <> " $ "

declare :: Text -> Value -> Generate ()
declare name original = do
  known <- gets (Map.member name . declarations)
  unless known $ do
    owner <- gets currentOwner
    modify' (\state -> state { declarations = Map.insert name (Declaration "" "" owner) (declarations state) })
    schemas <- gets definitions
    schema <- lift (normalize schemas original >>= fieldsOf)
    when (KM.lookup "nullable" schema == Just (Bool True)) (die (T.unpack name ++ ": nullable named schemas need an explicit representation"))
    opaque <- gets (Set.member name . identifiers)
    result <- case KM.lookup "enum" schema of
      Just (Array values) -> enumeration name (toList values)
      _ -> case KM.lookup "oneOf" schema <|> KM.lookup "anyOf" schema of
        Just (Array parts) -> union name (toList parts)
        _ | textAt "type" schema == Just "object" -> object name schema
        _ -> scalar name original opaque
    modify' (\state -> state { declarations = Map.insert name (result { declarationOwner = owner }) (declarations state) })

enumeration :: Text -> [Value] -> Generate Declaration
enumeration name values = do
  members <- forM values $ \value -> case value of
    String text -> pure (name <> identifier text, value)
    Number number -> pure (name <> identifier (T.pack (show number)), value)
    Bool flag -> pure (name <> if flag then "True" else "False", value)
    Null -> pure (name <> "Null", value)
    _ -> die (T.unpack name ++ ": enum member is not a scalar")
  let constructors = map fst members
  when (length (Set.fromList constructors) /= length constructors) (die "enum name collision")
  pure $ (\code -> Declaration (name <> "(..)") code "") $ T.unlines
    [ "data " <> name <> " = " <> T.intercalate " | " constructors <> " deriving (Eq, Show)"
    , instanceHead name <> "\\value -> " <> T.concat ["if value == (" <> valueCode value <> ") then pure " <> constructor <> " else " | (constructor, value) <- members]
        <> "fail \"unknown enumeration member\""
    , "instance ToJSON " <> name <> " where"
    , T.unlines ["  toJSON " <> constructor <> " = " <> valueCode value | (constructor, value) <- members]
    ]

union :: Text -> [Value] -> Generate Declaration
union name parts = do
  members <- forM (zip [1 :: Int ..] parts) $ \(index, schema) -> do
    let constructor = name <> "Branch" <> T.pack (show index)
    valueType <- typeOf (constructor <> "Value") schema
    pure (constructor, valueType)
  pure $ (\code -> Declaration (name <> "(..)") code "") $ T.unlines
    [ "data " <> name <> " = " <> T.intercalate " | " [constructor <> " (" <> valueType <> ")" | (constructor, valueType) <- members] <> " deriving (Eq, Show)"
    , instanceHead name <> "\\value -> " <> T.intercalate " <|> " ["(" <> constructor <> " <$> parseJSON value)" | (constructor, _) <- members]
    , "instance ToJSON " <> name <> " where"
    , T.unlines ["  toJSON (" <> constructor <> " value) = toJSON value" | (constructor, _) <- members]
    ]

scalar :: Text -> Value -> Bool -> Generate Declaration
scalar name original opaque = do
  schemas <- gets definitions
  shape <- lift (normalize schemas original >>= fieldsOf)
  valueType <- case textAt "$ref" shape of
    Just _ -> typeOf name original
    Nothing -> case textAt "type" shape of
      Just "string" -> pure "Text"
      Just "integer" -> pure "Integer"
      Just "number" -> pure "Scientific"
      Just "boolean" -> pure "Bool"
      Just "array" -> maybe (die "array has no item schema") (\item -> (\typ -> "[" <> typ <> "]") <$> typeOf (name <> "Item") item) (KM.lookup "items" shape)
      Nothing | KM.null shape -> pure "Value"
      other -> die (T.unpack name ++ ": unsupported scalar " ++ show other)
  let accessor = lower name <> "Value"
      constructor = "newtype " <> name <> " = " <> name <> (if opaque then " (" <> valueType <> ")" else " { " <> accessor <> " :: " <> valueType <> " }") <> (if opaque then " deriving (Eq, Ord, Show)" else " deriving (Eq, Show)")
      maker = "mk" <> name
      code = T.unlines
        [ constructor
        , instanceHead name <> "\\value -> " <> name <> " <$> parseJSON value"
        , "instance ToJSON " <> name <> " where toJSON (" <> name <> " value) = toJSON value"
        ] <> if opaque then T.unlines
          [ accessor <> " :: " <> name <> " -> " <> valueType
          , accessor <> " (" <> name <> " value) = value"
          , maker <> " :: " <> valueType <> " -> Either String " <> name
          , maker <> " value = parseEither parseJSON (toJSON value)"
          ] else ""
  pure $ Declaration (if opaque then T.intercalate ", " [name, accessor, maker] else name <> "(..)") code ""

object :: Text -> Object -> Generate Declaration
object name schema = do
  let properties = case KM.lookup "properties" schema of Just (Object values) -> KM.toAscList values; _ -> []
      required = case KM.lookup "required" schema of Just (Array values) -> [Key.fromText text | String text <- toList values]; _ -> []
      open = KM.lookup "additionalProperties" schema /= Just (Bool False)
      names = "[" <> T.intercalate ", " (map (literal . Key.toText . fst) properties) <> "]"
  members <- forM properties $ \(key, property) -> do
    fields <- lift (fieldsOf property)
    let suffix = identifier (Key.toText key)
        field = lower name <> suffix
        nullable = KM.lookup "nullable" fields == Just (Bool True)
        mandatory = key `elem` required
    valueType <- typeOf (name <> suffix) (Object (KM.delete "nullable" fields))
    let typ | nullable && not mandatory = "Presence (" <> valueType <> ")"
            | nullable || not mandatory = "Maybe (" <> valueType <> ")"
            | otherwise = valueType
        parser | nullable && not mandatory = "presence fields " <> literal (Key.toText key)
               | mandatory = "fields .: " <> literal (Key.toText key)
               | otherwise = "optional fields " <> literal (Key.toText key)
        encoder | nullable && not mandatory = "presencePair " <> literal (Key.toText key) <> " (" <> field <> " value)"
                | not mandatory = "optionalPair " <> literal (Key.toText key) <> " (" <> field <> " value)"
                | otherwise = "[(" <> literal (Key.toText key) <> ", toJSON (" <> field <> " value))]"
    pure (field <> " :: " <> typ, parser, encoder)
  extraType <- case KM.lookup "additionalProperties" schema of
    Just typed@(Object _) -> typeOf (name <> "AdditionalValue") typed
    _ -> pure "Value"
  let extras = lower name <> "AdditionalProperties"
      fieldTypes = [field | (field, _, _) <- members] ++ [extras <> " :: KM.KeyMap (" <> extraType <> ")" | open]
      parsers = [parser | (_, parser, _) <- members] ++ ["traverse parseJSON (withoutFields " <> names <> " fields)" | open]
      declaration = "data " <> name <> " = " <> name <> (if null fieldTypes then "" else " { " <> T.intercalate ", " fieldTypes <> " }") <> " deriving (Eq, Show)"
      reader | null parsers = "\\_ -> pure " <> name
             | otherwise = "\\fields -> " <> name <> " <$> " <> T.intercalate " <*> " parsers
      pairs = [pairCode | (_, _, pairCode) <- members]
      known = "KM.fromList (concat [" <> T.intercalate ", " pairs <> "])"
      encoder = "Object (" <> known <> (if open then " <> fmap toJSON (withoutFields " <> names <> " (" <> extras <> " value))" else "") <> ")"
      argument = if null members && not open then "_" else "value"
  pure $ (\code -> Declaration (name <> "(..)") code "") $ T.unlines
    [ declaration
    , instanceHead name <> "withObject " <> literal name <> " (" <> reader <> ")"
    , "instance ToJSON " <> name <> " where toJSON " <> argument <> " = " <> encoder
    ]

valueCode :: Value -> Text
valueCode value = case value of
  Object fields -> "Object (KM.fromList [" <> T.intercalate ", " ["(" <> literal (Key.toText key) <> ", " <> valueCode item <> ")" | (key, item) <- KM.toAscList fields] <> "])"
  Array items -> "Array (V.fromList [" <> T.intercalate ", " (map valueCode (toList items)) <> "])"
  String text -> "String " <> literal text
  Number number -> "Number (read " <> T.pack (show (show number)) <> ")"
  Bool boolean -> if boolean then "Bool True" else "Bool False"
  Null -> "Null"

generate :: Schemas -> Set.Set Text -> Either String ([Text], [(FilePath, Text)])
generate schemas ids = do
  mapM_ (checkSchema schemas) schemas
  state <- execStateT (forM_ (Map.toAscList schemas) $ \(name, value) -> do
    modify' (\current -> current { currentOwner = name })
    declare name value) (Generation schemas ids Map.empty "" Map.empty)
  let declared = Map.toAscList (declarations state)
      header = "-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.\n{-# LANGUAGE OverloadedStrings #-}\n\n"
      groups = map (sort . flattenSCC) (stronglyConnComp [(name, name, Set.toList (Map.findWithDefault Set.empty name (dependencies state))) | name <- Map.keys schemas])
      moduleName names = "Semiont.Internal.Generated.Models." <> case names of
        first : _ -> first
        [] -> error "empty strongly connected component"
      modules = Map.fromList [(root, moduleName roots) | roots <- groups, root <- roots]
      moduleNames = map moduleName groups
      imports = T.unlines ["import Control.Applicative ((<|>))", "import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))"
          , "import Data.Aeson.Types (parseEither)", "import qualified Data.Aeson.KeyMap as KM", "import Data.Scientific (Scientific)", "import Data.Text (Text)"
          , "import Semiont.Internal.Codec", "import Semiont.Types.Presence (Presence)"]
      modelFiles = [
        ("generated/" ++ T.unpack (T.replace "." "/" (moduleName roots)) ++ ".hs",
          header <> "{-# OPTIONS_GHC -Wno-unused-imports #-}\nmodule " <> moduleName roots <> "\n  ( "
          <> T.intercalate "\n  , " [declarationExport value | (_, value) <- declared, declarationOwner value `elem` roots]
          <> "\n  ) where\n" <> imports
          <> T.unlines ["import " <> target | target <- Set.toList (Set.fromList [moduleValue | root <- roots, dependency <- Set.toList (Map.findWithDefault Set.empty root (dependencies state)), Just moduleValue <- [Map.lookup dependency modules], moduleValue /= moduleName roots])]
          <> T.unlines [declarationCode value | (_, value) <- declared, declarationOwner value `elem` roots]) | roots <- groups]
      models = header <> "module Semiont.Types (" <> T.intercalate ", " (map ("module " <>) moduleNames) <> ") where\n"
        <> T.unlines (map ("import " <>) moduleNames)
      schemaCode = header <> T.unlines
        ["module Semiont.Internal.Generated.Schemas (schemas) where", "import Data.Aeson (Value(..))", "import qualified Data.Aeson.KeyMap as KM"
        , "import qualified Data.Map.Strict as Map", "import qualified Data.Vector as V", "import Semiont.Internal.Schema (Schemas)", "schemas :: Schemas"
        , "schemas = Map.fromList [" <> T.intercalate "\n  , " ["(" <> literal name <> ", " <> valueCode (runtimeSchema value) <> ")" | (name, value) <- Map.toAscList (definitions state)] <> "]"]
      roundTrips = header <> T.unlines
        ["module Semiont.Internal.Generated.RoundTrip (roundTrip) where", "import Data.Aeson (Value, parseJSON, toJSON)", "import Data.Aeson.Types (parseEither)", "import Data.Text (Text)"
        , "import Semiont.Types", "roundTrip :: Text -> Value -> Either String Value", "roundTrip name value = case name of"]
        <> T.unlines ["  " <> literal name <> " -> toJSON <$> (parseEither parseJSON value :: Either String " <> name <> ")" | name <- Map.keys (definitions state)]
        <> "  _ -> Left \"unknown schema in round-trip dispatcher\"\n"
  let files = modelFiles ++ [("src/Semiont/Types.hs", models), ("generated/Semiont/Internal/Generated/Schemas.hs", schemaCode), ("test/Semiont/Internal/Generated/RoundTrip.hs", roundTrips)]
  pure (moduleNames, [(path, T.stripEnd code <> "\n") | (path, code) <- files])

runtimeSchema :: Value -> Value
runtimeSchema (Object fields) = Object $ KM.mapWithKey transform $ KM.filterWithKey (\key _ -> key `notElem`
  ["description", "$comment", "title", "example", "examples", "default", "deprecated", "readOnly", "writeOnly", "discriminator"]) fields
  where
    transform "properties" (Object properties) = Object (fmap runtimeSchema properties)
    transform key (Array values) | key `elem` ["oneOf", "anyOf", "allOf"] = Array (fmap runtimeSchema values)
    transform key value | key `elem` ["items", "additionalProperties"] = runtimeSchema value
    transform _ value = value
runtimeSchema value = value

member :: Text -> Text
member = T.concat . map identifier . T.split (\character -> character == ':' || character == '-')

busDescriptors :: Schemas -> Value -> Either String (Schemas, [(FilePath, Text)])
busDescriptors original registry = do
  root <- fieldsOf registry
  rows <- arrayAt "channels" root
  operations <- arrayAt "operations" root
  audience <- maybe (Left "bus audience missing") fieldsOf (KM.lookup "audience" root)
  scoped <- arrayAt "scoped" audience >>= mapM stringValue
  everyone <- arrayAt "everyone" audience >>= mapM stringValue
  typed <- forM rows $ \row -> do
    fields <- fieldsOf row
    name <- required "channel" fields
    shape <- required "shape" fields
    (typ, extra) <- case shape of
      "schema" -> (\name' -> (name', [])) <$> required "schema" fields
      "storedEvent" -> pure (if KM.lookup "enriched" fields == Just (Bool True) then "EnrichedResourceEvent" else "StoredEventResponse", [])
      "envelope" -> do
        response <- required "schema" fields
        let name' = response <> "BusEnvelope"
        pure (name', [(name', Object (KM.fromList
          [("type", String "object"), ("properties", Object (KM.singleton "response" (Object (KM.singleton "$ref" (String (response <> ".json"))))))
          , ("required", Array (V.singleton (String "response"))), ("additionalProperties", Bool False)]))])
      "empty" -> pure ("EmptyBusPayload", [])
      "void" -> pure ("EmptyBusPayload", [])
      _ -> Left ("unknown bus shape: " ++ T.unpack shape)
    pure (name, member name, typ, name `elem` scoped, extra)
  let schemas' = Map.fromList (concat [extra | (_, _, _, _, extra) <- typed]) <> original
        <> Map.singleton "EmptyBusPayload" (Object (KM.fromList [("type", String "object"), ("maxProperties", Number 0), ("additionalProperties", Bool False)]))
      names = [name | (name, _, _, _, _) <- typed]
      constructors = [constructor | (_, constructor, _, _, _) <- typed]
      byName = Map.fromList [(name, (constructor, typ, scope)) | (name, constructor, typ, scope, _) <- typed]
      find name = maybe (Left ("operation names missing channel: " ++ T.unpack name)) Right (Map.lookup name byName)
  unless (Set.size (Set.fromList names) == length names) (Left "duplicate bus channel")
  unless (Set.size (Set.fromList constructors) == length constructors) (Left "colliding Haskell channel names")
  forM_ typed $ \(_, _, typ, _, _) -> unless (Map.member typ schemas') (Left ("unknown bus payload schema: " ++ T.unpack typ))
  ops <- forM operations $ \value -> do
    fields <- fieldsOf value
    request <- required "request" fields >>= find
    result <- required "result" fields >>= find
    failure <- required "failure" fields >>= find
    forM_ [request, result, failure] $ \(_, _, scope) -> when scope (Left "operation channel unexpectedly needs resource scope")
    pure (request, result, failure)
  failureMessages <- forM ops $ \((request,_,_),_,(_,typ,_)) -> do
    schema <- maybe (Left "operation failure schema is missing") Right (Map.lookup typ schemas') >>= normalize schemas' >>= fieldsOf
    properties <- maybe (Left "operation failure has no properties") fieldsOf (KM.lookup "properties" schema)
    requiredNames <- arrayAt "required" schema >>= traverse stringValue
    when ("code" `elem` requiredNames) (Left "failure codes became required: update typed error classification")
    let wordsAreText = case KM.lookup "message" properties of
          Just (Object definition) -> textAt "type" definition == Just "string"
          _ -> False
    unless ("message" `elem` requiredNames && wordsAreText) (Left "operation failure does not require its words as a string `message`")
    pure (request,lower typ <> identifier "message")
  let limits = [request | ((request,input,_),(_,output,_),(_,failure,_)) <- ops,
                output == "InferenceLimitsResult", input == "InferenceLimitsRequest", failure == "CommandError"]
      namedLimits = [constructor | (name,constructor,_,_,_) <- typed, ":limits-requested" `T.isSuffixOf` name]
  unless (sort limits == sort namedLimits) (Left "inference limits operations changed shape")
  let header = "-- Generated from protocol/specs/src/bus/registry.json. Do not edit.\n{-# LANGUAGE DataKinds, GADTs, KindSignatures, OverloadedStrings #-}\n"
      code = header <> T.unlines
        [ "module Semiont.Channels (Scope(..), ScopeArg(..), Channel(..), Operation(..), SomeOperation(..), allOperations, limitsOperations, channelName, channelNames, globalChannels, scopedChannels, channelSchema, channelIsScoped, encodePayload, decodePayload, operationChannels, persistedEventTypes) where"
        , "import Data.Aeson (Value(..), toJSON, parseJSON)"
        , "import Data.Aeson.Types (parseEither)"
        , "import Data.Text (Text)"
        , "import qualified Semiont.Internal.Required as Required"
        , "import qualified Semiont.Types as Types"
        , "data Scope = Global | Scoped"
        , "data ScopeArg (scope :: Scope) where"
        , "  NoScope :: ScopeArg 'Global"
        , "  InScope :: Types.ResourceId -> ScopeArg 'Scoped"
        , "data Channel (scope :: Scope) payload where"
        ] <> T.unlines ["  " <> constructor <> " :: Channel '" <> (if scope then "Scoped" else "Global") <> " Types." <> typ | (_, constructor, typ, scope, _) <- typed]
        <> "channelName :: Channel scope payload -> Text\n"
        <> T.unlines ["channelName " <> constructor <> " = " <> literal name | (name, constructor, _, _, _) <- typed]
        <> "channelNames :: [Text]\nchannelNames = [" <> T.intercalate ", " (map literal names) <> "]\n"
        <> "globalChannels :: [Text]\nglobalChannels = [" <> T.intercalate ", " (map literal (nub (everyone ++ [name | value <- operations, Right fields <- [fieldsOf value], key <- ["result", "failure"], Just name <- [textAt key fields]]))) <> "]\n"
        <> "scopedChannels :: [Text]\nscopedChannels = [" <> T.intercalate ", " (map literal scoped) <> "]\n"
        <> "channelSchema :: Channel scope payload -> Text\n"
        <> T.unlines ["channelSchema " <> constructor <> " = " <> literal typ | (_, constructor, typ, _, _) <- typed]
        <> "persistedEventTypes :: [Text]\npersistedEventTypes = ["
        <> T.intercalate ", " [literal event | row <- rows, Right fields <- [fieldsOf row], Just event <- [textAt "event" fields]] <> "]\n"
        <> "channelIsScoped :: Channel scope payload -> Bool\n"
        <> T.unlines ["channelIsScoped " <> constructor <> " = " <> (if scope then "True" else "False") | (_, constructor, _, scope, _) <- typed]
        <> "encodePayload :: Channel scope payload -> payload -> Value\n"
        <> T.unlines ["encodePayload " <> constructor <> " = toJSON" | (_, constructor, _, _, _) <- typed]
        <> "decodePayload :: Channel scope payload -> Value -> Either String payload\n"
        <> T.unlines ["decodePayload " <> constructor <> " = parseEither parseJSON . Required.channelValue (channelName " <> constructor <> ")" | (_, constructor, _, _, _) <- typed]
        <> "data Operation input output failure where\n"
        <> T.unlines ["  " <> request <> "Operation :: Operation Types." <> input <> " Types." <> output <> " Types." <> failure | ((request, input, _), (_, output, _), (_, failure, _)) <- ops]
        <> "data SomeOperation where\n  SomeOperation :: Operation input output failure -> SomeOperation\n"
        <> "allOperations :: [SomeOperation]\nallOperations = [" <> T.intercalate ", " ["SomeOperation " <> request <> "Operation" | ((request,_,_),_,_) <- ops] <> "]\n"
        <> "limitsOperations :: [Operation Types.InferenceLimitsRequest Types.InferenceLimitsResult Types.CommandError]\nlimitsOperations = [" <> T.intercalate ", " [request <> "Operation" | request <- limits] <> "]\n"
        <> "operationChannels :: Operation input output failure -> (Channel 'Global input, Channel 'Global output, Channel 'Global failure)\n"
        <> T.unlines ["operationChannels " <> request <> "Operation = (" <> request <> ", " <> result <> ", " <> failure <> ")" | ((request, _, _), (result, _, _), (failure, _, _)) <- ops]
      roundTrips = header <> T.unlines
        [ "module Semiont.Internal.Generated.ChannelRoundTrip (roundTripChannel, channelMetadata, operationMetadata) where"
        , "import Data.Aeson (Value)"
        , "import Data.Text (Text)"
        , "import Semiont.Channels"
        , "roundTripChannel :: Text -> Value -> Either String Value"
        , "roundTripChannel name value = case name of"
        ] <> T.unlines ["  " <> literal name <> " -> encodePayload " <> constructor <> " <$> decodePayload " <> constructor <> " value" | (name, constructor, _, _, _) <- typed]
        <> "  _ -> Left \"unknown channel in round-trip dispatcher\"\n"
        <> "channelMetadata :: Text -> Either String (Text, Text, Bool)\nchannelMetadata name = case name of\n"
        <> T.unlines ["  " <> literal name <> " -> Right (channelName " <> constructor <> ", channelSchema " <> constructor <> ", channelIsScoped " <> constructor <> ")" | (name, constructor, _, _, _) <- typed]
        <> "  _ -> Left \"unknown channel in metadata dispatcher\"\n"
        <> "operationMetadata :: [(Text, Text, Text)]\noperationMetadata = [" <> T.intercalate ", " ["names " <> request <> "Operation" | ((request, _, _), _, _) <- ops] <> "]\n  where names operation = let (asked, result, failure) = operationChannels operation in (channelName asked, channelName result, channelName failure)\n"
  let failures = header <> T.unlines
        [ "module Semiont.Internal.Generated.OperationFailure (message) where"
        , "import Data.Text (Text)"
        , "import Semiont.Channels"
        , "import qualified Semiont.Types as Types"
        , "message :: Operation input output failure -> failure -> Text"
        ] <> T.unlines ["message " <> request <> "Operation = Types." <> accessor | (request,accessor) <- failureMessages]
  pure (schemas', [("generated/Semiont/Internal/Generated/OperationFailure.hs", failures), ("src/Semiont/Channels.hs", code), ("test/Semiont/Internal/Generated/ChannelRoundTrip.hs", roundTrips)])
  where
    required key fields = maybe (Left ("missing bus field: " ++ show key)) Right (textAt key fields)
    arrayAt key fields = case KM.lookup key fields of Just (Array values) -> Right (toList values); _ -> Left ("missing bus array: " ++ show key)
    stringValue (String value) = Right value
    stringValue _ = Left "bus name is not a string"

readJSON :: FilePath -> IO Value
readJSON path = do
  bytes <- Bytes.readFile path
  either (ioError . userError . ((path ++ ": ") ++)) pure (eitherDecodeStrict' bytes)

readUTF8 :: FilePath -> IO Text
readUTF8 path = Bytes.readFile path >>= either (ioError . userError . ((path ++ ": ") ++) . show) pure . decodeUtf8'

main :: IO ()
main = do
  args <- getArgs
  (root, checkOnly) <- case args of [directory] -> pure (directory, False); ["--check", directory] -> pure (directory, True); _ -> ioError (userError "expected [--check] repository-root")
  let source = root </> "protocol/specs/src"
      output = root </> "packages/haskell/sdk"
  spec <- readJSON (source </> "openapi.json") >>= either (ioError . userError) pure . fieldsOf
  components <- maybe (ioError (userError "OpenAPI has no components")) pure (KM.lookup "components" spec)
    >>= either (ioError . userError) pure . fieldsOf
  entries <- maybe (ioError (userError "OpenAPI has no schemas")) pure (KM.lookup "schemas" components)
    >>= either (ioError . userError) pure . fieldsOf
  schemas <- fmap Map.fromList $ forM (KM.toList entries) $ \(key, value) -> do
    fields <- either (ioError . userError) pure (fieldsOf value)
    definition <- case textAt "$ref" fields of
      Nothing -> pure value
      Just path -> do
        unless (all (`elem` ["$ref", "description", "$comment"]) (KM.keys fields))
          (ioError (userError "OpenAPI schema reference has unsupported siblings"))
        unless (takeExtension (T.unpack path) == ".json" && referenceName path == Key.toText key && not (T.isInfixOf "://" path))
          (ioError (userError "OpenAPI schema reference needs an explicit Haskell naming rule"))
        readJSON (source </> T.unpack path)
    pure (Key.toText key, definition)
  kinds <- readJSON (root </> "protocol/specs/src/identifiers/kinds.json")
  ids <- case kinds of
    Object objectFields -> case KM.lookup "kinds" objectFields of
      Just (Array values) -> forM (toList values) $ \value -> either (ioError . userError) pure $ do
        fields <- fieldsOf value
        maybe (Left "identifier kind has no schema") Right (textAt "schema" fields)
      _ -> ioError (userError "identifier kinds is not an array")
    _ -> ioError (userError "identifier kinds is not an object")
  registry <- readJSON (root </> "protocol/specs/src/bus/registry.json")
  (carrier, transportFiles) <- transportFacts root registry kinds
  upload <- maybe (ioError (userError "ResourceUpload schema missing")) pure (Map.lookup "ResourceUpload" schemas)
    >>= either (ioError . userError) pure . fieldsOf
  properties <- maybe (ioError (userError "ResourceUpload has no properties")) pure (KM.lookup "properties" upload)
    >>= either (ioError . userError) pure . fieldsOf
  unless (KM.member "file" properties) (ioError (userError "ResourceUpload has no file property"))
  requiredUpload <- case KM.lookup "required" upload of
    Just (Array required) -> pure required
    _ -> ioError (userError "ResourceUpload has no required list")
  let metadata = Object (KM.insert "properties" (Object (KM.delete "file" properties))
        (KM.insert "required" (Array (V.filter (/= String "file") requiredUpload)) upload))
  payloadTypes <- T.filter (`notElem` (" \n\r\t" :: String)) <$> readUTF8 (root </> "packages/typescript/core/src/payload-types.ts")
  unless ("exporttypeEngineWithLimits=EngineEntry&{limits?:components['schemas']['InferenceLimits']};" `T.isInfixOf` payloadTypes)
    (ioError (userError "EngineWithLimits changed: update its derived Haskell adapter"))
  engine <- maybe (ioError (userError "EngineEntry schema missing")) pure (Map.lookup "EngineEntry" schemas)
    >>= either (ioError . userError) pure . normalize schemas >>= either (ioError . userError) pure . fieldsOf
  engineProperties <- maybe (ioError (userError "EngineEntry properties missing")) pure (KM.lookup "properties" engine)
    >>= either (ioError . userError) pure . fieldsOf
  let engineWithLimits = Object (KM.insert "properties" (Object (KM.insert "limits" (Object (KM.singleton "$ref" (String "InferenceLimits.json"))) engineProperties)) engine)
  gatherOptions <- maybe (ioError (userError "GatherResourceRequestOptions schema missing")) pure (Map.lookup "GatherResourceRequestOptions" schemas)
    >>= either (ioError . userError) pure . fieldsOf
  searchOptions <- maybe (ioError (userError "MatchSearchRequest schema missing")) pure (Map.lookup "MatchSearchRequest" schemas)
    >>= either (ioError . userError) pure . fieldsOf
  searchProperties <- maybe (ioError (userError "MatchSearchRequest properties missing")) pure (KM.lookup "properties" searchOptions)
    >>= either (ioError . userError) pure . fieldsOf
  forM_ ["resourceId", "referenceId", "context"] $ \name ->
    unless (KM.member name searchProperties) (ioError (userError "MatchSearchRequest positional input disappeared"))
  let optionSchemas =
        [ ("EngineWithLimits",engineWithLimits)
        , ("GatherResourceOptions",Object (KM.delete "required" gatherOptions))
        , ("MatchSearchOptions",Object (KM.insert "properties" (Object (foldr KM.delete searchProperties ["resourceId", "referenceId", "context"])) (KM.delete "required" searchOptions)))
        ]
  storedTable <- readJSON (root </> "protocol/specs/src/session/stored.json") >>= either (ioError . userError) pure . fieldsOf
  stored <- maybe (ioError (userError "stored-session authority missing")) pure (KM.lookup "storedSession" storedTable)
  openResource <- maybe (ioError (userError "open-resource authority missing")) pure (KM.lookup "openResource" storedTable)
  pending <- maybe (ioError (userError "pending-authorization authority missing")) pure (KM.lookup "pendingAuthorization" storedTable)
    >>= either (ioError . userError) pure . fieldsOf
  pendingProperties <- maybe (ioError (userError "pending-authorization properties missing")) pure (KM.lookup "properties" pending)
    >>= either (ioError . userError) pure . fieldsOf
  issuer <- maybe (ioError (userError "pending authorization's issuer missing")) pure (KM.lookup "issuer" pendingProperties)
  signIn <- readJSON (root </> "protocol/specs/src/sign-in-store/SignIn.json")
  sessionAdapters <- readJSON (output </> "codegen/session-adapters.json") >>= either (ioError . userError) pure . fieldsOf
  annotationAdapters <- readJSON (output </> "codegen/annotation-adapters.json") >>= either (ioError . userError) pure . fieldsOf
  registryTable <- readJSON (root </> "protocol/specs/src/client/registry.json") >>= either (ioError . userError) pure . fieldsOf
  registryTypes <- maybe (ioError (userError "registry records missing")) pure (KM.lookup "types" registryTable)
    >>= either (ioError . userError) pure . fieldsOf
  registryRecords <- either (ioError . userError) pure
    (traverse (pointedReferences [("",registryTable),("../session/stored.json",storedTable)]) registryTypes)
  sessionCases <- readJSON (root </> "protocol/specs/src/session/cases.json") >>= either (ioError . userError) pure . fieldsOf
  endReasons <- maybe (ioError (userError "session end reasons missing")) pure (KM.lookup "told" sessionCases)
  endReasonsName <- either (ioError . userError) pure (fieldsOf endReasons)
    >>= maybe (ioError (userError "session end reasons have no title")) pure . textAt "title"
  unitsTable <- readJSON (root </> "protocol/specs/src/client/state-units.json") >>= either (ioError . userError) pure . fieldsOf
  notices <- maybe (ioError (userError "session notices missing")) pure (KM.lookup "notices" unitsTable)
    >>= either (ioError . userError) pure . fieldsOf
  noticeRecords <- either (ioError . userError) pure (traverse (pointedReferences [("../session/cases.json",sessionCases)]) notices)
  let endReasonsRecord = KM.singleton (Key.fromText endReasonsName) endReasons
      specRecords = registryRecords <> noticeRecords <> endReasonsRecord
      adapterNames=concatMap KM.keys [sessionAdapters,annotationAdapters,registryRecords,noticeRecords,endReasonsRecord]
  unless (length adapterNames==length (nub adapterNames)) (ioError (userError "an SDK-owned adapter and a record of the spec share a name"))
  let storedSchemas =
        [(Key.toText name,value) | (name,value) <- KM.toList (sessionAdapters <> annotationAdapters <> specRecords)] ++ [ ("SignIn",signIn), ("StoredSession",stored), ("OpenResource",openResource)
        , ("IssuerEndpoints",issuer)
        , ("PendingAuthorization",Object (KM.insert "properties" (Object (KM.insert "issuer"
            (Object (KM.singleton "$ref" (String "IssuerEndpoints.json"))) pendingProperties)) pending))
        ]
  storedKeys <- case KM.lookup "keys" storedTable of
    Just (Array values) -> forM (toList values) $ \value -> do
      fields <- either (ioError . userError) pure (fieldsOf value)
      case (textAt "member" fields,textAt "key" fields) of
        (Just name,Just key) -> pure (name,key)
        _ -> ioError (userError "stored key has no name or value")
    _ -> ioError (userError "stored keys missing")
  storedPrefixes <- forM ["sessionKeyPrefix","lastEventIdKeyPrefix","cacheKeyPrefix"] $ \name -> do
    fields <- maybe (ioError (userError "stored prefix missing")) pure (KM.lookup (Key.fromText name) storedTable)
      >>= either (ioError . userError) pure . fieldsOf
    prefix <- maybe (ioError (userError "stored prefix value missing")) pure (textAt "prefix" fields)
    pure (name,prefix)
  unless (length (nub (map fst (storedKeys++storedPrefixes))) == length (storedKeys++storedPrefixes))
    (ioError (userError "stored names collide"))
  surface <- readJSON (root </> "protocol/specs/src/client/surface.json") >>= either (ioError . userError) pure . fieldsOf
  factoryFields <- case KM.lookup "modules" surface of
    Just (Array modules) -> case [listed | Object row <- toList modules, textAt "module" row == Just "registry", Just (Array members) <- [KM.lookup "members" row], Object listed <- toList members, textAt "member" listed == Just "SessionFactoryOptions"] of
      [listed] -> case KM.lookup "fields" listed of
        Just (Array names) | names' <- [name | String name <- toList names], length names' == V.length names -> pure names'
        _ -> ioError (userError "SessionFactoryOptions states no fields in surface.json")
      _ -> ioError (userError "surface.json's registry module does not list SessionFactoryOptions once")
    _ -> ioError (userError "surface.json states no modules")
  -- Each member's type is Haskell's own: a storage, the signals unit, an error callback.
  let factoryTypes = [("kb","KnowledgeBase"),("storage","Storage.SessionStorage"),("signals","Signals.SessionSignals"),("onError","SessionError -> IO ()")]
  factoryMembers <- forM factoryFields $ \field ->
    maybe (ioError (userError ("SessionFactoryOptions' " ++ T.unpack field ++ " has no Haskell type"))) (pure . (,) field) (lookup field factoryTypes)
  unless (length factoryFields == length factoryTypes && length (nub factoryFields) == length factoryFields)
    (ioError (userError "SessionFactoryOptions' fields in surface.json are not those Haskell types"))
  oauth <- readJSON (root </> "protocol/specs/src/session/oauth.json") >>= either (ioError . userError) pure . fieldsOf
  clients <- case KM.lookup "clients" oauth of
    Just (Array rows) -> forM (toList rows) $ \row -> do
      fields <- either (ioError . userError) pure (fieldsOf row)
      case (textAt "name" fields,textAt "id" fields) of
        (Just name,Just value) -> pure (name<>"ClientId",value)
        _ -> ioError (userError "OAuth client missing its name or id")
    _ -> ioError (userError "OAuth clients missing")
  scopeFields <- maybe (ioError (userError "OAuth scope missing")) pure (KM.lookup "scope" oauth)
    >>= either (ioError . userError) pure . fieldsOf
  scope <- maybe (ioError (userError "OAuth scope value missing")) pure (textAt "value" scopeFields)
  assertion <- readJSON (root </> "protocol/specs/src/session/client-assertion-cases.json") >>= either (ioError . userError) pure . fieldsOf
  assertionStrings <- forM ["grantType","assertionType"] $ \name -> do
    value <- maybe (ioError (userError "client assertion string missing")) pure (textAt (Key.fromText name) assertion)
    pure (name,value)
  lifetime <- case KM.lookup "lifetimeSeconds" assertion of
    Just (Number value) | value > 0 && fromInteger (floor value) == value -> pure (floor value :: Integer)
    _ -> ioError (userError "client assertion lifetime missing or not a positive whole second")
  principals <- readJSON (root </> "protocol/specs/src/principals/cases.json") >>= either (ioError . userError) pure . fieldsOf
  principalValues <- forM ["person","agent"] $ \name -> do
    value <- maybe (ioError (userError "principal template missing")) pure (textAt (Key.fromText name) principals)
    unless (T.count "{domain}" value==1 && T.count "{subject}" value==1)
      (ioError (userError "principal template placeholders changed"))
    pure (name,value)
  busLog <- readJSON (root </> "protocol/specs/src/bus/log-cases.json") >>= either (ioError . userError) pure . fieldsOf
  withheldNames <- case KM.lookup "names" busLog of
    Just (Array values) -> forM (toList values) $ \value -> case value of String name->pure name; _->ioError (userError "bus-log name is not text")
    _ -> ioError (userError "bus-log authority has no names")
  let principalFile = ("generated/Semiont/Internal/Generated/Principals.hs",T.unlines
        (["-- Generated from principals/cases.json; do not edit.","{-# LANGUAGE OverloadedStrings #-}"
         ,"module Semiont.Internal.Generated.Principals where","import Data.Text (Text)"]
         ++ concat [[name<>" :: Text",name<>" = "<>literal value] | (name,value)<-principalValues]))
      busLogFile = ("generated/Semiont/Internal/Generated/BusLog.hs",T.unlines
        ["-- Generated from bus/log-cases.json; do not edit.","{-# LANGUAGE OverloadedStrings #-}"
        ,"module Semiont.Internal.Generated.BusLog (withheldNames) where","import Data.Text (Text)"
        ,"withheldNames :: [Text]","withheldNames = ["<>T.intercalate "," (map literal withheldNames)<>"]"])
  ownerOnly <- readJSON (root </> "protocol/specs/src/sign-in-store/owner-only.json") >>= either (ioError . userError) pure . fieldsOf
  ownerValues <- forM ["directoryMode","fileMode","accessList"] $ \name -> do
    fields <- maybe (ioError (userError "owner-only policy member missing")) pure (KM.lookup (Key.fromText name) ownerOnly)
      >>= either (ioError . userError) pure . fieldsOf
    value <- maybe (ioError (userError "owner-only policy value missing")) pure (textAt "value" fields)
    pure (name,value)
  directoryMode <- maybe (ioError (userError "owner directory mode missing")) pure (lookup "directoryMode" ownerValues)
  fileMode <- maybe (ioError (userError "owner file mode missing")) pure (lookup "fileMode" ownerValues)
  accessList <- maybe (ioError (userError "owner access list missing")) pure (lookup "accessList" ownerValues)
  forM_ [directoryMode,fileMode] $ \mode -> unless (T.length mode==4 && "0" `T.isPrefixOf` mode && T.all (`elem` ("01234567"::String)) mode)
    (ioError (userError "owner-only mode is not a four-digit octal mode"))
  unless (T.count "{owner}" accessList==1 && T.all (<'\128') accessList) (ioError (userError "native owner policy needs one ASCII owner placeholder"))
  storeContract <- readUTF8 (root </> "protocol/specs/src/sign-in-store/README.md")
  forM_ ["<stateDir>/tokens.json","<stateDir>/tokens.lock","on one byte of the lock file","OffsetHigh: 0x40000000"] $ \fact ->
    unless (fact `T.isInfixOf` storeContract) (ioError (userError "native sign-in file/lock policy changed: update its native binding"))
  let storePolicy = ("generated/Semiont/Internal/Generated/semiont_store_policy.h",T.unlines
        ["/* Generated from sign-in-store/owner-only.json; lock range gated against its README. */"
        ,"#define SEMIONT_DIRECTORY_MODE "<>directoryMode
        ,"#define SEMIONT_FILE_MODE "<>fileMode
        ,"#define SEMIONT_ACCESS_LIST "<>literal accessList
        ,"#define SEMIONT_LOCK_HIGH 0x40000000"
        ,"#define SEMIONT_LOCK_BYTES 1"])
      storeNames = ("generated/Semiont/Internal/Generated/SignInStore.hs",T.unlines
        ["-- File names gated against sign-in-store/README.md; do not edit."
        ,"module Semiont.Internal.Generated.SignInStore where"
        ,"signInFileName, signInLockName :: FilePath"
        ,"signInFileName = "<>literal "tokens.json"
        ,"signInLockName = "<>literal "tokens.lock"])
      assertionFile = ("generated/Semiont/Internal/Generated/ClientAssertion.hs",T.unlines
        (["-- Generated from session/client-assertion-cases.json; do not edit.","{-# LANGUAGE OverloadedStrings #-}"
         ,"module Semiont.Internal.Generated.ClientAssertion where","import Data.Text (Text)"]
         ++ concat [[name<>" :: Text",name<>" = "<>literal value] | (name,value) <- assertionStrings]
         ++ ["lifetimeSeconds :: Integer","lifetimeSeconds = "<>T.pack (show lifetime)]))
  let oauthFile = ("generated/Semiont/Internal/Generated/OAuth.hs", T.unlines
        (["-- Generated from session/oauth.json; do not edit.","{-# LANGUAGE OverloadedStrings #-}"
         ,"module Semiont.Internal.Generated.OAuth where","import Data.Text (Text)"]
          ++ concat [[name<>" :: Text",name<>" = "<>literal value] | (name,value) <- clients++[("signInScope",scope)]]))
      storedFile = ("generated/Semiont/Internal/Generated/Stored.hs", T.unlines
        (["-- Generated from session/stored.json; do not edit."
         ,"{-# LANGUAGE OverloadedStrings #-}","module Semiont.Internal.Generated.Stored where","import Data.Text (Text)"]
         ++ concat [[name<>" :: Text",name<>" = "<>literal value] | (name,value) <- storedKeys++storedPrefixes]))
      factoryFile = ("generated/Semiont/Internal/Generated/SessionFactoryOptions.hs", T.unlines
        (["-- Generated from client/surface.json; do not edit."
         ,"module Semiont.Internal.Generated.SessionFactoryOptions where"
         ,"import Semiont.Types (KnowledgeBase)","import Semiont.Errors (SessionError)"
         ,"import qualified Semiont.SessionStorage as Storage","import qualified Semiont.State.SessionSignals as Signals"
         ,"data SessionFactoryOptions = SessionFactoryOptions"]
         ++ [(if index == (0 :: Int) then "  { " else "  , ")<>"sessionFactoryOptions"<>identifier field<>" :: "<>typ | (index,(field,typ)) <- zip [0..] factoryMembers]
         ++ ["  }"]))
  (httpSchemas, httpFiles) <- httpFacts root (Object spec) schemas
  unless (length storedSchemas==length (nub (map fst storedSchemas))) (ioError (userError "duplicate stored SDK schema"))
  forM_ ("ResourceUploadMetadata" : "TraceCarrier" : map fst (storedSchemas ++ optionSchemas ++ httpSchemas)) $ \name ->
    when (Map.member name schemas) (ioError (userError ("adapter schema name is owned by OpenAPI: " ++ T.unpack name)))
  facts <- generateFacts root
  workerFiles <- workerFacts root member
  (busSchemas, busFiles) <- either (ioError . userError) pure (busDescriptors (Map.insert "TraceCarrier" carrier (Map.insert "ResourceUploadMetadata" metadata (Map.fromList (storedSchemas ++ optionSchemas ++ httpSchemas) <> schemas))) registry)
  (moduleNames, models) <- either (ioError . userError) pure (generate busSchemas (Set.fromList ids))
  template <- readUTF8 (output </> "semiont.cabal.in")
  forM_ ["@VERSION@", "@MODEL_MODULES@"] $ \marker ->
    unless (T.count marker template == 1) (ioError (userError ("manifest template must contain exactly one " ++ T.unpack marker)))
  package <- readJSON (root </> "package.json") >>= either (ioError . userError) pure . fieldsOf
  version <- maybe (ioError (userError "root package.json has no version")) pure (textAt "version" package)
  license <- readUTF8 (root </> "LICENSE")
  let manifest = T.replace "@VERSION@" version $ T.replace "@MODEL_MODULES@" (T.intercalate "\n" (map ("    " <>) moduleNames)) template
      generated = ("LICENSE", license) : ("semiont.cabal", manifest) : [storedFile,factoryFile,oauthFile,assertionFile,storePolicy,storeNames,principalFile,busLogFile] ++ busFiles ++ models ++ facts ++ transportFiles ++ httpFiles ++ workerFiles
      modelsDirectory = output </> "generated/Semiont/Internal/Generated/Models"
      expected = Set.fromList (map (normalise . (output </>)) (map fst generated))
  existsModels <- doesDirectoryExist modelsDirectory
  when existsModels $ do
    previous <- listDirectory modelsDirectory
    forM_ [modelsDirectory </> file | file <- previous, takeExtension file == ".hs"] $ \path ->
      unless (Set.member (normalise path) expected) $ do
        when checkOnly (ioError (userError ("stale generated module: " ++ path)))
        text <- readUTF8 path
        unless ("-- Generated from protocol/specs/src." `T.isPrefixOf` text) (ioError (userError ("unexpected file in generated modules: " ++ path)))
        removeFile path
  forM_ generated $ \(relative, content) -> do
    let path = output </> relative
    exists <- doesFileExist path
    if checkOnly then do
      unless exists (ioError (userError ("missing generated file: " ++ path)))
      actual <- readUTF8 path
      unless (actual == content) (ioError (userError ("generated file drift: " ++ path)))
    else do
      actual <- if exists then Just <$> readUTF8 path else pure Nothing
      when (actual /= Just content) (createDirectoryIfMissing True (takeDirectory path) >> Bytes.writeFile path (encodeUtf8 content))
  putStrLn ("Generated " ++ show (Map.size schemas) ++ " protocol schemas and typed bus descriptors in " ++ show (length moduleNames) ++ " model modules")
