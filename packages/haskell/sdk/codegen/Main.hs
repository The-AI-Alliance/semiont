{-# LANGUAGE OverloadedStrings #-}

module Main (main) where

import Control.Monad (forM, forM_, unless, when)
import Control.Applicative ((<|>))
import Control.Monad.State.Strict (StateT, execStateT, gets, modify', lift)
import Data.Aeson (Object, Value(..), eitherDecodeStrict')
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Char (isAlphaNum, isDigit, toLower, toUpper)
import Data.Foldable (toList)
import Data.Graph (flattenSCC, stronglyConnComp)
import Data.List (sort)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Text.IO as T
import qualified Data.Vector as V
import Numeric (showHex)
import Semiont.Internal.Schema (Schemas, checkSchema, normalize)
import System.Directory (createDirectoryIfMissing, doesDirectoryExist, doesFileExist, listDirectory, removeFile)
import System.Environment (getArgs)
import System.FilePath ((</>), takeBaseName, takeDirectory, takeExtension)

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
      constructor = "newtype " <> name <> " = " <> name <> (if opaque then " (" <> valueType <> ")" else " { " <> accessor <> " :: " <> valueType <> " }") <> " deriving (Eq, Show)"
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

schemaStamps :: Schemas -> Value -> Either String [Text]
schemaStamps schemas value = do
  fields <- normalize schemas value >>= fieldsOf
  properties <- case KM.lookup "properties" fields of Nothing -> pure KM.empty; Just node -> fieldsOf node
  nested <- fmap concat $ forM ["oneOf", "anyOf"] $ \key -> case KM.lookup key fields of
    Nothing -> pure []
    Just (Array parts) -> concat <$> traverse (schemaStamps schemas) (toList parts)
    Just _ -> Left "schema union is not an array"
  pure (Set.toAscList (Set.fromList (filter (T.isPrefixOf "_") (map Key.toText (KM.keys properties)) ++ nested)))

busDescriptors :: Schemas -> Value -> Either String (Schemas, [(FilePath, Text)])
busDescriptors original registry = do
  root <- fieldsOf registry
  rows <- arrayAt "channels" root
  operations <- arrayAt "operations" root
  audience <- maybe (Left "bus audience missing") fieldsOf (KM.lookup "audience" root)
  scoped <- arrayAt "scoped" audience >>= mapM stringValue
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
  stamps <- forM rows $ \row -> do
    fields <- fieldsOf row
    name <- required "channel" fields
    shape <- required "shape" fields
    declared <- if shape /= "schema" then pure [] else do
      typ <- required "schema" fields
      schema <- maybe (Left "missing channel schema") Right (Map.lookup typ schemas')
      schemaStamps schemas' schema
    pure (member name, declared)
  ops <- forM operations $ \value -> do
    fields <- fieldsOf value
    request <- required "request" fields >>= find
    result <- required "result" fields >>= find
    failure <- required "failure" fields >>= find
    forM_ [request, result, failure] $ \(_, _, scope) -> when scope (Left "operation channel unexpectedly needs resource scope")
    pure (request, result, failure)
  let header = "-- Generated from protocol/specs/src/bus/registry.json. Do not edit.\n{-# LANGUAGE DataKinds, GADTs, KindSignatures, OverloadedStrings #-}\n"
      code = header <> T.unlines
        [ "module Semiont.Channels (Scope(..), ScopeArg(..), Channel(..), Operation(..), channelName, channelIsScoped, encodePayload, decodePayload, operationChannels) where"
        , "import Data.Aeson (Value(..), toJSON, parseJSON)"
        , "import qualified Data.Aeson.Key as Key"
        , "import qualified Data.Aeson.KeyMap as KM"
        , "import Data.Aeson.Types (parseEither)"
        , "import Data.Text (Text)"
        , "import qualified Data.Text as T"
        , "import qualified Semiont.Types as Types"
        , "data Scope = Global | Scoped"
        , "data ScopeArg (scope :: Scope) where"
        , "  NoScope :: ScopeArg 'Global"
        , "  InScope :: Types.ResourceId -> ScopeArg 'Scoped"
        , "data Channel (scope :: Scope) payload where"
        ] <> T.unlines ["  " <> constructor <> " :: Channel '" <> (if scope then "Scoped" else "Global") <> " Types." <> typ | (_, constructor, typ, scope, _) <- typed]
        <> "channelName :: Channel scope payload -> Text\n"
        <> T.unlines ["channelName " <> constructor <> " = " <> literal name | (name, constructor, _, _, _) <- typed]
        <> "channelIsScoped :: Channel scope payload -> Bool\n"
        <> T.unlines ["channelIsScoped " <> constructor <> " = " <> (if scope then "True" else "False") | (_, constructor, _, scope, _) <- typed]
        <> "encodePayload :: Channel scope payload -> payload -> Value\n"
        <> T.unlines ["encodePayload " <> constructor <> " = toJSON" | (_, constructor, _, _, _) <- typed]
        <> "decodePayload :: Channel scope payload -> Value -> Either String payload\n"
        <> T.unlines ["decodePayload " <> constructor <> " = parseEither parseJSON . withoutStamps (channelStamps " <> constructor <> ")" | (_, constructor, _, _, _) <- typed]
        <> "channelStamps :: Channel scope payload -> [Text]\n"
        <> T.unlines ["channelStamps " <> constructor <> " = [" <> T.intercalate ", " (map literal declared) <> "]" | (constructor, declared) <- stamps]
        <> "withoutStamps :: [Text] -> Value -> Value\nwithoutStamps declared (Object fields) = Object (KM.filterWithKey (\\key _ -> let name = Key.toText key in not (T.isPrefixOf \"_\" name) || name `elem` declared) fields)\nwithoutStamps _ value = value\n"
        <> "data Operation input output failure where\n"
        <> T.unlines ["  " <> request <> "Operation :: Operation Types." <> input <> " Types." <> output <> " Types." <> failure | ((request, input, _), (_, output, _), (_, failure, _)) <- ops]
        <> "operationChannels :: Operation input output failure -> (Channel 'Global input, Channel 'Global output, Channel 'Global failure)\n"
        <> T.unlines ["operationChannels " <> request <> "Operation = (" <> request <> ", " <> result <> ", " <> failure <> ")" | ((request, _, _), (result, _, _), (failure, _, _)) <- ops]
      roundTrips = header <> T.unlines
        [ "module Semiont.Internal.Generated.ChannelRoundTrip (roundTripChannel) where"
        , "import Data.Aeson (Value)"
        , "import Data.Text (Text)"
        , "import Semiont.Channels"
        , "roundTripChannel :: Text -> Value -> Either String Value"
        , "roundTripChannel name value = case name of"
        ] <> T.unlines ["  " <> literal name <> " -> encodePayload " <> constructor <> " <$> decodePayload " <> constructor <> " value" | (name, constructor, _, _, _) <- typed]
        <> "  _ -> Left \"unknown channel in round-trip dispatcher\"\n"
  pure (schemas', [("src/Semiont/Channels.hs", code), ("test/Semiont/Internal/Generated/ChannelRoundTrip.hs", roundTrips)])
  where
    required key fields = maybe (Left ("missing bus field: " ++ show key)) Right (textAt key fields)
    arrayAt key fields = case KM.lookup key fields of Just (Array values) -> Right (toList values); _ -> Left ("missing bus array: " ++ show key)
    stringValue (String value) = Right value
    stringValue _ = Left "bus name is not a string"
    member = T.concat . map identifier . T.split (\character -> character == ':' || character == '-')

readJSON :: FilePath -> IO Value
readJSON path = do
  bytes <- Bytes.readFile path
  either (ioError . userError . ((path ++ ": ") ++)) pure (eitherDecodeStrict' bytes)

main :: IO ()
main = do
  args <- getArgs
  (root, checkOnly) <- case args of [directory] -> pure (directory, False); ["--check", directory] -> pure (directory, True); _ -> ioError (userError "expected [--check] repository-root")
  let source = root </> "protocol/specs/src/components/schemas"
      output = root </> "packages/haskell/sdk"
  files <- filter ((== ".json") . takeExtension) . sort <$> listDirectory source
  schemas <- Map.fromList <$> traverse (\file -> (,) (T.pack (takeBaseName file)) <$> readJSON (source </> file)) files
  kinds <- readJSON (root </> "protocol/specs/src/identifiers/kinds.json")
  ids <- case kinds of
    Object objectFields -> case KM.lookup "kinds" objectFields of
      Just (Array values) -> forM (toList values) $ \value -> either (ioError . userError) pure $ do
        fields <- fieldsOf value
        maybe (Left "identifier kind has no schema") Right (textAt "schema" fields)
      _ -> ioError (userError "identifier kinds is not an array")
    _ -> ioError (userError "identifier kinds is not an object")
  registry <- readJSON (root </> "protocol/specs/src/bus/registry.json")
  (busSchemas, busFiles) <- either (ioError . userError) pure (busDescriptors schemas registry)
  (moduleNames, models) <- either (ioError . userError) pure (generate busSchemas (Set.fromList ids))
  template <- T.readFile (output </> "semiont.cabal.in")
  forM_ ["@VERSION@", "@MODEL_MODULES@"] $ \marker ->
    unless (T.count marker template == 1) (ioError (userError ("manifest template must contain exactly one " ++ T.unpack marker)))
  package <- readJSON (root </> "package.json") >>= either (ioError . userError) pure . fieldsOf
  version <- maybe (ioError (userError "root package.json has no version")) pure (textAt "version" package)
  license <- T.readFile (root </> "LICENSE")
  let manifest = T.replace "@VERSION@" version $ T.replace "@MODEL_MODULES@" (T.intercalate "\n" (map ("    " <>) moduleNames)) template
      generated = ("LICENSE", license) : ("semiont.cabal", manifest) : busFiles ++ models
      modelsDirectory = output </> "generated/Semiont/Internal/Generated/Models"
      expected = Set.fromList (map (output </>) (map fst generated))
  existsModels <- doesDirectoryExist modelsDirectory
  when existsModels $ do
    previous <- listDirectory modelsDirectory
    forM_ [modelsDirectory </> file | file <- previous, takeExtension file == ".hs"] $ \path ->
      unless (Set.member path expected) $ do
        when checkOnly (ioError (userError ("stale generated module: " ++ path)))
        text <- T.readFile path
        unless ("-- Generated from protocol/specs/src." `T.isPrefixOf` text) (ioError (userError ("unexpected file in generated modules: " ++ path)))
        removeFile path
  forM_ generated $ \(relative, content) -> do
    let path = output </> relative
    exists <- doesFileExist path
    if checkOnly then do
      unless exists (ioError (userError ("missing generated file: " ++ path)))
      actual <- T.readFile path
      unless (actual == content) (ioError (userError ("generated file drift: " ++ path)))
    else do
      actual <- if exists then Just <$> T.readFile path else pure Nothing
      when (actual /= Just content) (createDirectoryIfMissing True (takeDirectory path) >> T.writeFile path content)
  putStrLn ("Generated " ++ show (length files) ++ " protocol schemas and typed bus descriptors in " ++ show (length moduleNames) ++ " model modules")
