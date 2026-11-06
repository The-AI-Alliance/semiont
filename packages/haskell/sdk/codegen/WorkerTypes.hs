{-# LANGUAGE OverloadedStrings #-}
module WorkerTypes (workerTypes) where

import Control.Monad (forM, unless)
import Data.Char (isAlphaNum, toLower, toUpper)
import Data.Text (Text)
import qualified Data.Text as T
import TransportFacts (between)

data Field = Field Text Text Bool

upper :: Text -> Text
upper = first toUpper
lower :: Text -> Text
lower = first toLower
first :: (Char -> Char) -> Text -> Text
first f value = case T.uncons value of Nothing -> value; Just (c, rest) -> T.cons (f c) rest

uncomment :: Text -> Either String Text
uncomment source = case T.breakOn "/*" source of
  (before, rest) | T.null rest -> Right before
  (before, rest) -> do
    let (_, end) = T.breakOn "*/" (T.drop 2 rest)
    unless (not (T.null end)) (Left "unterminated worker interface comment")
    (before <>) <$> uncomment (T.drop 2 end)

split :: Char -> Text -> Either String [Text]
split delimiter source = go 0 "" [] (T.unpack source)
  where
    go :: Int -> Text -> [Text] -> String -> Either String [Text]
    go depth current found [] = do
      unless (depth == 0) (Left "unbalanced worker interface type")
      pure (reverse (if T.null (T.strip current) then found else T.strip current : found))
    go depth current found (c:rest)
      | c == delimiter && depth == 0 = go depth "" (T.strip current : found) rest
      | c `elem` ("{<([" :: String) = go (depth + 1) (T.snoc current c) found rest
      | c `elem` ("}>)]" :: String) = if depth <= 0 then Left "unbalanced worker interface type" else go (depth - 1) (T.snoc current c) found rest
      | otherwise = go depth (T.snoc current c) found rest

fields :: Text -> Either String [Field]
fields source = split ';' source >>= traverse field
  where
    field line = do
      let (raw, rest) = T.breakOn ":" (T.strip line)
          optional = T.isSuffixOf "?" raw
          name = if optional then T.dropEnd 1 raw else raw
      unless (not (T.null rest) && not (T.null name) && T.all isAlphaNum name) (Left "unsupported worker interface field")
      pure (Field name (T.strip (T.drop 1 rest)) optional)

record :: Text -> [Field] -> Either String [Text]
record name members = do
  unless (not (null members)) (Left "empty worker interface")
  typed <- forM members $ \(Field key typ optional) -> do
    (hs, nested) <- fieldType (name <> upper key) typ
    pure (key, if optional then "Maybe (" <> hs <> ")" else hs, optional, nested)
  let accessor key = lower name <> upper key
      code = T.unlines
        [ "data " <> name <> " = " <> name <> " { " <> T.intercalate ", " [accessor key <> " :: " <> typ | (key,typ,_,_) <- typed] <> " } deriving (Eq, Show)"
        , "instance FromJSON " <> name <> " where"
        , "  parseJSON = withObject " <> quoted name <> " $ \\row -> " <> name <> T.concat
            [(if index == (0 :: Int) then " <$> " else " <*> ") <> (if optional then "optional row " <> quoted key else "row .: " <> quoted key) | (index,(key,_,optional,_)) <- zip [0..] typed]
        , "instance ToJSON " <> name <> " where"
        , "  toJSON value = Object (KM.fromList (concat [" <> T.intercalate ", "
            [if optional then "optionalPair " <> quoted key <> " (" <> accessor key <> " value)" else "[(" <> quoted key <> ", toJSON (" <> accessor key <> " value))]" | (key,_,optional,_) <- typed] <> "]))"
        ]
  pure (concat [nested | (_,_,_,nested) <- typed] ++ [code])
  where quoted = T.pack . show . T.unpack

fieldType :: Text -> Text -> Either String (Text, [Text])
fieldType name typ = do
  alternatives <- split '|' typ
  case alternatives of
    [value, "null"] -> do (hs, nested) <- fieldType name value; pure ("Maybe (" <> hs <> ")", nested)
    [_] | Just inner <- T.stripPrefix "{" typ >>= T.stripSuffix "}" -> do
      members <- fields inner
      nested <- record name members
      pure (name, nested)
    [_] | Just inner <- T.stripSuffix "[]" typ -> do (hs,nested) <- fieldType name inner; pure ("[" <> hs <> "]",nested)
    [_] | Just inner <- T.stripPrefix "Record<string, " typ >>= T.stripSuffix ">" -> do (hs,nested) <- fieldType name inner; pure ("KM.KeyMap (" <> hs <> ")",nested)
    ["string"] -> pure ("Text",[])
    ["number"] -> pure ("Scientific",[])
    ["BusRequestErrorCode"] -> pure ("BusRequestCode",[])
    [ref] | ref `elem` ["JobId", "JobType", "UnitCursor", "FailureClass"] -> pure (ref,[])
    _ -> Left ("unsupported worker interface type: " ++ T.unpack typ)

workerTypes :: Text -> Either String [(FilePath, Text)]
workerTypes source = do
  clean <- uncomment source
  declared <- forM ["ClaimRefusal", "WorkerVitals", "HeldJobStall", "JobCheckpoint"] $ \name -> do
    members <- between ("export interface " <> name <> " {\n") "\n}" clean >>= fields
    pure (name, members)
  checkpoint <- maybe (Left "missing worker checkpoint") Right (lookup "JobCheckpoint" declared)
  failure <- between "export interface JobFailure extends Partial<JobCheckpoint> {\n" "\n}" clean >>= fields
  records <- concat <$> traverse (uncurry record) (declared ++ [("JobReached", [Field key typ True | Field key typ _ <- checkpoint]), ("JobFailure", [Field key typ True | Field key typ _ <- checkpoint] ++ failure)])
  let code = T.unlines
        [ "-- Generated from packages/typescript/sdk/src/claims.ts. Do not edit."
        , "{-# LANGUAGE OverloadedStrings #-}"
        , "module Semiont.Worker.Types where"
        , "import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))"
        , "import qualified Data.Aeson.KeyMap as KM"
        , "import Data.Scientific (Scientific)"
        , "import Data.Text (Text)"
        , "import Semiont.ErrorCodes (BusRequestCode)"
        , "import Semiont.Internal.Codec (optional, optionalPair)"
        , "import Semiont.Types (JobId, JobType, UnitCursor, FailureClass)"
        ] <> T.concat records
  pure [("generated/Semiont/Worker/Types.hs",code)]
