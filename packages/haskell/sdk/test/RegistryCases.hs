{-# LANGUAGE OverloadedStrings #-}
module RegistryCases (registryCases) where

import Control.Monad (forM_, unless)
import Data.Aeson (FromJSON, Value(..), fromJSON, Result(..), eitherDecodeStrict', encode, toJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Lazy as Lazy
import Data.Foldable (toList)
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import Data.Text.Encoding (decodeUtf8)
import qualified Semiont.Registry.Identity as Identity
import qualified Semiont.Registry.Stored as Stored
import qualified Semiont.Registry.Resources as Resources
import qualified Semiont.SessionStorage as Storage
import Semiont.Types
import System.FilePath ((</>))

require :: String -> Bool -> IO ()
require label good=unless good (ioError (userError label))
member :: Text -> Value -> Value
member key (Object fields)=maybe (error "missing registry case member") id (KM.lookup (Key.fromText key) fields)
member _ _=error "registry case is no object"
decode :: FromJSON result => Value -> IO result
decode value=case fromJSON value of Error message->ioError (userError message); Success parsed->pure parsed
fixture :: FromJSON result => Map.Map Text Value -> Text -> IO result
fixture fixtures name=maybe (ioError (userError "No registry fixture")) decode (Map.lookup name fixtures)

registryCases :: FilePath -> Map.Map Text Value -> IO ()
registryCases root fixtures = do
  table <- Bytes.readFile (root </> "protocol/specs/src/session/registry-cases.json") >>= either (ioError . userError) pure . eitherDecodeStrict'
  case member "cases" table of
    Array rows -> forM_ (toList rows) $ \row -> do
      one <- decode (member "one" row)
      other <- decode (member "other" row)
      expected <- decode (member "samePlace" row)
      require "registry did not match knowledge bases by their whole origin" (Identity.samePlace one other==expected)
    _ -> ioError (userError "Registry authority has no cases")
  case member "openResourceOrder" table of
    Array rows -> forM_ (toList rows) $ \row -> do
      open <- decode (member "open" row)
      shown <- decode (member "shown" row)
      require "registry did not show open resources by place, then by when each was opened" (map openResourceId (Resources.sortOpenResources open)==shown)
    _ -> ioError (userError "Registry authority has no open-resource order")
  storage <- Storage.newMemoryStorage
  kb <- fixture fixtures "KnowledgeBase"
  let value=case toJSON kb of
        Object fields -> Object (KM.insert "email" (String "not-part-of-a-kb@example.test") fields)
        _ -> error "knowledge base is no object"
  Storage.set storage Stored.knowledgeBasesKey (decodeUtf8 (Lazy.toStrict (encode [Null,value,Object KM.empty])))
  loaded <- Stored.loadKnowledgeBases storage
  require "registry did not reject invalid rows and project a KB's own members" (loaded==[kb])
  Stored.saveKnowledgeBases storage loaded
  saved <- Storage.get storage Stored.knowledgeBasesKey
  require "registry copied a previous person's profile into an entry" (saved==Just (decodeUtf8 (Lazy.toStrict (encode [kb]))))
  require "stored session-key reading did not use the authority's prefix" (Stored.kbOfSessionKey (Stored.sessionKey "kb")==Just "kb" && Stored.kbOfSessionKey "unrelated"==Nothing)
  resource <- either (ioError . userError) pure (mkResourceId "one")
  other <- either (ioError . userError) pure (mkResourceId "two")
  third <- either (ioError . userError) pure (mkResourceId "three")
  let tab identity name at order=OpenResource identity (Just "text/plain") name at order Nothing mempty
      one=tab resource "old" 1 1
      two=tab other "unknown" 2 2
      three=tab third "gone" 3 3
      ready=TabCheckBranch2 (TabCheckBranch2Value Nothing "new" TabVerdictReady)
      gone=TabCheckBranch1 (TabCheckBranch1Value TabVerdictGone)
      checks=Map.fromList [(resource,ready),(third,gone)]
  require "resource checks lost unknown/unseen tabs, or failed to refresh an affirmed one"
    (Resources.applyTabChecks [one,two,three] checks==[one {openResourceName="new"},two])
  putStrLn "PASS every registry whole-origin case and open-resource order, projected stored entries and open-resource verdicts"
