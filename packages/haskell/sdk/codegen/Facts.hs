{-# LANGUAGE OverloadedStrings #-}

module Facts (generateFacts) where

import Control.Monad (forM, forM_, unless, (>=>))
import Data.Aeson (Value(..), eitherDecodeStrict')
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Char (isAlphaNum, toUpper)
import Data.Foldable (toList)
import Data.List (sortOn)
import qualified Data.Map.Strict as Map
import Data.Ord (Down(..))
import Data.Scientific (floatingOrInteger)
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Vector as V
import System.FilePath ((</>))

object :: Value -> Either String (KM.KeyMap Value)
object (Object fields) = Right fields
object _ = Left "fact is not an object"

required :: Key.Key -> KM.KeyMap Value -> Either String Value
required key fields = maybe (Left ("missing fact: " ++ show key)) Right (KM.lookup key fields)

text :: Value -> Either String Text
text (String value) = Right value
text _ = Left "fact is not a string"

array :: Value -> Either String [Value]
array (Array values) = Right (toList values)
array _ = Left "fact is not an array"

integer :: Value -> Either String Integer
integer (Number value) = either (const (Left "fact is not an integer")) Right (floatingOrInteger value :: Either Double Integer)
integer _ = Left "fact is not a number"

name :: Text -> Text
name = T.concat . map capital . filter (not . T.null) . T.split (not . isAlphaNum)
  where capital value = case T.uncons value of Nothing -> value; Just (first, rest) -> T.cons (toUpper first) rest

quoted :: Text -> Text
quoted = T.pack . show . T.unpack

ensureUnique :: [Text] -> Either String ()
ensureUnique names = unless (Set.size (Set.fromList names) == length names) (Left "fact names collide in Haskell")

header :: Text -> Text
header source = "-- Generated from " <> source <> "; do not edit.\n{-# LANGUAGE OverloadedStrings #-}\n"

vocabularies :: Text -> Text -> Text -> Value -> Either String [(FilePath, Text)]
vocabularies authority moduleName testName source = do
  groups <- object source
  generated <- forM (sortOn fst (KM.toList (KM.delete "$comment" groups))) $ \(key, value) -> do
    fields <- object value
    unless (all (`elem` ["docs", "codes", "unrecognizedFailure", "unclassified"]) (KM.keys fields)) (Left "unsupported error-family fact")
    codes <- required "codes" fields >>= array >>= traverse object
    unless (not (null codes)) (Left "empty error vocabulary")
    forM_ codes $ \row -> unless (all (`elem` ["code", "wire", "status", "statusFrom", "docs"]) (KM.keys row)) (Left "unsupported error-code fact")
    strings <- traverse (required "code" >=> text) codes
    let family = Key.toText key
        typ = name family <> "Code"
        function = family <> "Code"
        constructor code = name family <> name (case T.breakOn "." code of (whole, rest) -> if T.null rest then whole else T.drop 1 rest)
        members = map constructor strings
        lookupCode code = if code `elem` strings then Right (constructor code) else Left "error fallback names an unknown code"
    ensureUnique strings
    ensureUnique members
    wires <- forM [(wire, code) | (row, code) <- zip codes strings, Just wire <- [KM.lookup "wire" row]] $ \(wire, code) -> do
      wireName <- text wire
      pure (wireName, constructor code)
    ensureUnique (map fst wires)
    wireCode <- case KM.lookup "unrecognizedFailure" fields of
      Nothing -> if null wires then pure "" else Left "wire classifier has no declared fallback"
      Just fallback -> do
        fallbackConstructor <- text fallback >>= lookupCode
        pure $ T.unlines
          [ function <> "FromWire :: Maybe Text -> " <> typ
          , function <> "FromWire value = case value of"
          ] <> T.unlines ["  Just " <> quoted wire <> " -> " <> member | (wire, member) <- wires]
            <> "  _ -> " <> fallbackConstructor <> "\n"
    statuses <- forM [(row, code) | (row, code) <- zip codes strings, KM.member "status" row || KM.member "statusFrom" row] $ \(row, code) -> do
      unless (not (KM.member "status" row && KM.member "statusFrom" row)) (Left "ambiguous HTTP classifier")
      case KM.lookup "status" row of
        Just status -> (\number -> (True, number, constructor code)) <$> integer status
        Nothing -> (\number -> (False, number, constructor code)) <$> (required "statusFrom" row >>= integer)
    statusCode <- case KM.lookup "unclassified" fields of
      Nothing -> if null statuses then pure "" else Left "HTTP classifier has no declared fallback"
      Just fallback -> do
        fallbackConstructor <- text fallback >>= lookupCode
        let exact = [(number, member) | (True, number, member) <- statuses]
            ranges = sortOn (Down . fst) [(number, member) | (False, number, member) <- statuses]
        ensureUnique (map (T.pack . show . fst) exact)
        pure $ function <> "FromStatus :: Int -> " <> typ <> "\n" <> function <> "FromStatus status\n"
          <> T.unlines ["  | status == " <> T.pack (show number) <> " = " <> member | (number, member) <- exact]
          <> T.unlines ["  | status >= " <> T.pack (show number) <> " = " <> member | (number, member) <- ranges]
          <> "  | otherwise = " <> fallbackConstructor <> "\n"
    let code = T.unlines
          [ "data " <> typ <> " = " <> T.intercalate " | " members <> " deriving (Eq, Ord, Show, Enum, Bounded)"
          , function <> " :: " <> typ <> " -> Text"
          ] <> T.unlines [function <> " " <> member <> " = " <> quoted wire | (member, wire) <- zip members strings]
            <> "parse" <> typ <> " :: Text -> Maybe " <> typ <> "\nparse" <> typ <> " value = case value of\n"
            <> T.unlines ["  " <> quoted wire <> " -> Just " <> member | (member, wire) <- zip members strings]
            <> "  _ -> Nothing\ninstance ToJSON " <> typ <> " where toJSON = String . " <> function <> "\n"
            <> "instance FromJSON " <> typ <> " where parseJSON = withText " <> quoted typ
            <> " (\\value -> maybe (fail \"unknown error code\") pure (parse" <> typ <> " value))\n"
            <> wireCode <> statusCode
        exports = [typ <> "(..)", function, "parse" <> typ]
          ++ [function <> "FromWire" | not (T.null wireCode)] ++ [function <> "FromStatus" | not (T.null statusCode)]
    pure (typ, family, exports, code)
  ensureUnique [typ | (typ, _, _, _) <- generated]
  let code = header authority <> "module " <> moduleName <> " ("
        <> T.intercalate ", " (concat [exports | (_, _, exports, _) <- generated]) <> ") where\n"
        <> "import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withText)\nimport Data.Text (Text)\n"
        <> T.intercalate "\n" [body | (_, _, _, body) <- generated]
      tests = header authority <> T.unlines
        [ "module Semiont.Internal.Generated." <> testName <> " (roundTripError) where"
        , "import Data.Aeson (Value, parseJSON, toJSON)"
        , "import Data.Aeson.Types (parseEither)"
        , "import Data.Text (Text)"
        , "import " <> moduleName
        , "roundTripError :: Text -> Value -> Either String Value"
        , "roundTripError family value = case family of"
        ] <> T.unlines ["  " <> quoted family <> " -> toJSON <$> (parseEither parseJSON value :: Either String " <> typ <> ")" | (typ, family, _, _) <- generated]
        <> "  _ -> Left \"unknown error-code family\"\n"
  pure [("src/" ++ T.unpack (T.replace "." "/" moduleName) ++ ".hs", code), ("test/Semiont/Internal/Generated/" ++ T.unpack testName ++ ".hs", tests)]

discoveryReasons :: Value -> Either String [(FilePath, Text)]
discoveryReasons source = do
  fields <- object source
  unless (all (`elem` ["$comment", "reasons"]) (KM.keys fields)) (Left "unsupported discovery reason fact")
  reasons <- required "reasons" fields >>= array >>= traverse object
  codes <- forM reasons $ \row -> do
    unless (all (`elem` ["reason", "docs"]) (KM.keys row)) (Left "unsupported discovery reason row")
    reason <- required "reason" row >>= text
    pure (Object (KM.insert "code" (String reason) (KM.delete "reason" row)))
  vocabularies "protocol/specs/src/client/discovery-absent.json" "Semiont.Discovery.Reasons" "DiscoveryReasonRoundTrip"
    (Object (KM.singleton "discoveryAbsent" (Object (KM.singleton "codes" (Array (V.fromList codes))))))

data TimingValue = Scalar Integer | Budget (Map.Map Key.Key Integer)

timing :: Value -> Either String [(FilePath, Text)]
timing source = do
  fields <- object source
  unless (all (`elem` ["$comment", "timing"]) (KM.keys fields)) (Left "unsupported timing table fact")
  rows <- required "timing" fields >>= array >>= traverse object
  pairs <- forM rows $ \row -> do
    unless (all (`elem` ["name", "value", "docs"]) (KM.keys row)) (Left "unsupported timing row fact")
    named <- required "name" row >>= text
    raw <- required "value" row
    value <- case raw of
      Object fields' -> Budget . Map.fromList . KM.toList <$> traverse integer fields'
      _ -> Scalar <$> integer raw
    pure (named, value)
  ensureUnique (map fst pairs)
  let objects = [fields' | (_, Budget fields') <- pairs]
      shapes = Set.fromList (map (Set.fromList . Map.keys) objects)
  unless (Set.size shapes == 1) (Left "timing retry budgets do not have one shape")
  keys <- case Set.toList shapes of [one] -> pure (Set.toAscList one); _ -> Left "no retry budget shape"
  unless (not (null keys)) (Left "empty retry budget shape")
  forM_ pairs $ \(_, value) -> unless (all (>= 0) (case value of Scalar number -> [number]; Budget fields' -> Map.elems fields')) (Left "negative timing fact")
  let field key = "retry" <> name (Key.toText key)
      definition = "data RetryBudget = RetryBudget { " <> T.intercalate ", " [field key <> " :: Integer" | key <- keys] <> " } deriving (Eq, Show)\n"
        <> "instance ToJSON RetryBudget where toJSON value = object [" <> T.intercalate ", " [quoted (Key.toText key) <> " .= " <> field key <> " value" | key <- keys] <> "]\n"
        <> "instance FromJSON RetryBudget where\n  parseJSON = withObject \"RetryBudget\" $ \\fields -> do\n"
        <> "    unless (all (`elem` [" <> T.intercalate ", " [quoted (Key.toText key) | key <- keys] <> "]) (KM.keys fields)) (fail \"Unknown retry budget member\")\n"
        <> "    value <- RetryBudget <$> " <> T.intercalate " <*> " ["fields .: " <> quoted (Key.toText key) | key <- keys] <> "\n"
        <> "    unless (all (>= 0) [" <> T.intercalate ", " [field key <> " value" | key <- keys] <> "]) (fail \"Negative retry budget member\")\n    pure value\n"
      valueCode (Budget fields') = "RetryBudget { " <> T.intercalate ", " [field key <> " = " <> T.pack (show number) | (key, number) <- Map.toAscList fields'] <> " }"
      valueCode (Scalar number) = T.pack (show number)
      code = header "protocol/specs/src/client/timing.json" <> "module Semiont.Timing (RetryBudget(..), " <> T.intercalate ", " (map fst pairs) <> ") where\n"
        <> "import Control.Monad (unless)\nimport Data.Aeson (FromJSON(..), ToJSON(..), withObject, object, (.:), (.=))\nimport qualified Data.Aeson.KeyMap as KM\n" <> definition
        <> T.intercalate "\n" [named <> " :: " <> (case value of Budget _ -> "RetryBudget"; _ -> "Integer") <> "\n" <> named <> " = " <> valueCode value <> "\n" | (named, value) <- pairs]
      tests = header "protocol/specs/src/client/timing.json" <> T.unlines
        [ "module Semiont.Internal.Generated.TimingValues (timingValues) where"
        , "import Data.Aeson (Value, toJSON)"
        , "import Data.Text (Text)"
        , "import qualified Data.Map.Strict as Map"
        , "import Semiont.Timing"
        , "timingValues :: Map.Map Text Value"
        , "timingValues = Map.fromList [" <> T.intercalate ", " ["(" <> quoted named <> ", toJSON " <> named <> ")" | (named, _) <- pairs] <> "]"
        ]
      settings = header "protocol/specs/src/client/timing.json" <> T.unlines
        [ "module Semiont.Timing.Settings (Settings(..), protocolSettings, withOverrides) where"
        , "import Control.Monad (unless)"
        , "import Data.Aeson (FromJSON(..), ToJSON(..), Result(..), Value(..), fromJSON, withObject, object, (.:), (.=))"
        , "import qualified Data.Aeson.KeyMap as KM"
        , "import qualified Semiont.Timing as Base"
        , "data Settings = Settings { " <> T.intercalate ", " [named <> " :: " <> (case value of Budget _ -> "Base.RetryBudget"; _ -> "Integer") | (named,value) <- pairs] <> " } deriving (Eq, Show)"
        , "protocolSettings :: Settings"
        , "protocolSettings = Settings { " <> T.intercalate ", " [named <> " = Base." <> named | (named,_) <- pairs] <> " }"
        , "instance ToJSON Settings where toJSON value = object [" <> T.intercalate ", " [quoted named <> " .= " <> named <> " value" | (named,_) <- pairs] <> "]"
        , "instance FromJSON Settings where"
        , "  parseJSON = withObject \"Settings\" $ \\fields -> do"
        , "    unless (all (`elem` [" <> T.intercalate ", " [quoted named | (named,_) <- pairs] <> "]) (KM.keys fields)) (fail \"Unknown timing member\")"
        , "    value <- Settings <$> " <> T.intercalate " <*> " ["fields .: " <> quoted named | (named,_) <- pairs]
        , "    unless (all (>= 0) [" <> T.intercalate ", " [named <> " value" | (named,Scalar _) <- pairs] <> "]) (fail \"Negative timing member\")"
        , "    pure value"
        , "withOverrides :: Value -> Either String Settings"
        , "withOverrides (Object overrides) = case toJSON protocolSettings of"
        , "  Object fields -> case fromJSON (Object (KM.union overrides fields)) of Error reason -> Left reason; Success value -> Right value"
        , "  _ -> Left \"Protocol timing is not an object\""
        , "withOverrides _ = Left \"Timing overrides are not an object\""
        ]
  pure [("src/Semiont/Timing.hs", code), ("src/Semiont/Timing/Settings.hs", settings), ("test/Semiont/Internal/Generated/TimingValues.hs", tests)]

generateFacts :: FilePath -> IO [(FilePath, Text)]
generateFacts root = fmap concat $ forM
  [("errors/codes.json", vocabularies "protocol/specs/src/errors/codes.json" "Semiont.ErrorCodes" "ErrorRoundTrip")
  , ("client/timing.json", timing), ("client/discovery-absent.json", discoveryReasons)] $ \(path, generate) -> do
  bytes <- Bytes.readFile (root </> "protocol/specs/src" </> path)
  value <- either (ioError . userError) pure (eitherDecodeStrict' bytes)
  either (ioError . userError . ((path ++ ": ") ++)) pure (generate value)
