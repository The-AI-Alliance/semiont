{-# LANGUAGE OverloadedStrings #-}
module IdentityCases (identityCases) where

import Control.Monad (forM_, unless)
import Data.Aeson (Value(..), FromJSON, fromJSON, Result(..), eitherDecodeStrict', toJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Foldable (toList)
import Data.Text (Text)
import qualified Semiont.Identity as Identity
import System.FilePath ((</>))

require :: String -> Bool -> IO ()
require label good=unless good (ioError (userError label))
member :: Text -> Value -> Value
member key (Object fields)=maybe (error "missing identity case member") id (KM.lookup (Key.fromText key) fields)
member _ _=error "identity case is not an object"
array :: Value -> [Value]
array (Array values)=toList values
array _=error "identity cases are not an array"
decode :: FromJSON result => Value -> IO result
decode value=case fromJSON value of Success parsed->pure parsed; Error diagnostic->ioError (userError diagnostic)
readTable :: FilePath -> String -> IO Value
readTable root name=Bytes.readFile (root </> "protocol/specs/src" </> name) >>= either (ioError . userError) pure . eitherDecodeStrict'

identityCases :: FilePath -> IO ()
identityCases root = do
  principals <- readTable root "principals/cases.json"
  forM_ [("people",Identity.personDid),("agents",Identity.agentDid)] $ \(section,derive) ->
    forM_ (array (member section principals)) $ \row -> do
      domain <- decode (member "domain" row)
      subject <- decode (member "subject" row)
      actual <- either (ioError . userError) pure (derive domain subject)
      require "principal DID differs from shared authority" (toJSON actual==member "did" row)
  identities <- readTable root "kb-identity/cases.json"
  forM_ (array (member "cases" identities)) $ \row -> case member "domain" row of
    Null -> pure ()
    value -> do
      domain <- decode value
      did <- either (ioError . userError) pure (Identity.kbDid domain)
      require "knowledge-base DID differs" (toJSON did==member "did" row)
      require "knowledge-base resource audience differs" (toJSON (Identity.kbResource domain)==member "resource" row)
  putStrLn "PASS every principal DID and declared knowledge-base identity derivation case"
