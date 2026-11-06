{-# LANGUAGE OverloadedStrings #-}
module TokenStorageCases (tokenStorageCases) where

import Control.Concurrent.Async (replicateConcurrently_)
import Control.Monad (forM_, unless)
import Data.Aeson (FromJSON, Result(..), Value(..), eitherDecodeStrict', encode, fromJSON, object, (.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Lazy as Lazy
import qualified Data.ByteString.Base64.URL as Base64
import Data.Foldable (toList)
import Data.Scientific (Scientific)
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (decodeUtf8)
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.Tokens as Tokens
import qualified Semiont.Timing.Settings as Timing
import System.FilePath ((</>))

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))
member :: Text -> Value -> Value
member name (Object fields) = maybe (error "missing token-case member") id (KM.lookup (Key.fromText name) fields)
member _ _ = error "token case is not an object"
array :: Value -> [Value]
array (Array values) = toList values
array _ = error "token cases are not an array"
readValue :: FromJSON value => Value -> IO value
readValue value = case fromJSON value of Error message -> ioError (userError message); Success parsed -> pure parsed
jwt :: Value -> Text
jwt values = "e30."<>decodeUtf8 (Base64.encodeUnpadded (Lazy.toStrict (encode values)))<>"."

tokenStorageCases :: FilePath -> IO ()
tokenStorageCases root = do
  table <- Bytes.readFile (root </> "protocol/specs/src/session/cases.json") >>= either (ioError . userError) pure . eitherDecodeStrict'
  forM_ (array (member "refreshSchedule" table)) $ \row -> do
    now <- readValue (member "now" row)
    expected <- readValue (member "delay" row)
    token <- case row of
      Object fields -> case (KM.lookup "claims" fields,KM.lookup "token" fields) of
        (Just values,Nothing) -> pure (jwt values)
        (Nothing,Just (String value)) -> pure value
        _ -> ioError (userError "schedule case needs claims or a token")
      _ -> ioError (userError "schedule case is not an object")
    require "token renewal schedule differs from the shared table" (Tokens.refreshDelay Timing.protocolSettings token now==expected)
  forM_ (array (member "tokenExpiry" table)) $ \row -> do
    token <- readValue (member "token" row)
    expiry <- readValue (member "exp" row) :: IO (Maybe Scientific)
    require "token expiry differs from the shared table" (Tokens.tokenExpiry token==expiry)
    case expiry of
      Nothing -> require "an unreadable expiry was treated as usable" (Tokens.isTokenExpired token 0)
      Just instant -> do
        require "a future token was treated as expired" (not (Tokens.isTokenExpired token (instant-1)))
        require "expiry equality differs from the shared helpers" (not (Tokens.isTokenExpired token instant))
        require "a past token was treated as usable" (Tokens.isTokenExpired token (instant+1))
  let name="Zoë λ O’Connor"
      custom=jwt (object ["note" .= (name::Text), "other" .= (3::Integer), "exp" .= (0::Integer)])
  require "a Unicode textual claim did not survive base64url" (Tokens.textClaim custom "note"==Just name)
  require "a nontext claim was given words" (Tokens.textClaim custom "other"==Nothing)
  require "a missing claim was fabricated" (Tokens.textClaim custom "missing"==Nothing)
  require "zero exp was read as a time" (Tokens.tokenExpiry custom==Nothing)
  storage <- Storage.newMemoryStorage
  replicateConcurrently_ 200 (Storage.update storage "shared" (Just . maybe "x" (<>"x")))
  value <- Storage.get storage "shared"
  require "atomic memory storage lost a concurrent writer" (fmap Text.length value==Just 200)
  Storage.set storage "another" "retained"
  Storage.delete storage "shared"
  require "memory storage removed another key" . (==Just "retained") =<< Storage.get storage "another"
  require "memory storage kept a deleted value" . (==Nothing) =<< Storage.get storage "shared"
  release <- Storage.subscribe storage (\_ _ -> ioError (userError "one-context storage reported an external write"))
  require "one-context storage claimed an external subscription" (maybe True (const False) release)
  putStrLn "PASS every token-expiry/renewal helper case, UTF-8/base64url text claims and atomic memory storage"
