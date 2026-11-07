{-# LANGUAGE OverloadedStrings #-}
module BusLogCases (busLogCases) where

import Control.Monad (forM_, unless)
import Data.Aeson (Value(..), eitherDecodeStrict', object, (.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Foldable (toList)
import qualified Data.Vector as Vector
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8)
import Data.IORef
import qualified Semiont.Internal.BusLog as Log
import Semiont.Internal.Generated.ChannelRoundTrip (roundTripChannel)
import System.FilePath ((</>))

require :: String -> Bool -> IO ()
require label good=unless good (ioError (userError label))
member :: Text -> Value -> Value
member key (Object fields)=maybe (error "missing bus log case member") id (KM.lookup (Key.fromText key) fields)
member _ _=error "bus log case is not an object"

busLogCases :: FilePath -> IO ()
busLogCases root = do
  table <- Bytes.readFile (root </> "protocol/specs/src/bus/log-cases.json") >>= either (ioError . userError) pure . eitherDecodeStrict'
  case member "cases" table of
    Array cases -> forM_ (toList cases) $ \row -> do
      let payload=member "payload" row
      require "bus log exposed a credential or changed another value" (Log.shown payload==member "shown" row)
      case row of
        Object fields -> case KM.lookup "channel" fields of
          Nothing -> pure ()
          Just (String name) -> require "bus log fixture does not hold to its typed channel payload"
            (case roundTripChannel name payload of Right value->value==payload; _->False)
          _ -> ioError (userError "bus log case channel is not text")
        _ -> ioError (userError "bus log case is not an object")
    _ -> ioError (userError "bus log authority declares no cases")
  forM_ [Null,Bool True,Number 9007199254740993,String "password",toJSONList] $ \payload ->
    require "bus log changed a scalar/array or exposed a nested credential" (Log.shown payload==case payload of Array _ -> shownList; _ -> payload)
  linesSeen <- newIORef []
  let write value=modifyIORef' linesSeen (<>[value])
  Log.content (Log.Logger False write) "GET" (object ["token" .= String "not-logged"])
  require "disabled logger wrote a line" . null =<< readIORef linesSeen
  Log.content (Log.Logger True write) "PUT" (object ["name" .= String "document","token" .= String "secret-payload"])
  written <- readIORef linesSeen
  require "enabled logger did not write exactly one line" (length written==1)
  forM_ written $ \line -> do
    require "logger omitted operation/channel" ("[bus PUT] content " `Text.isPrefixOf` line)
    let (_,payload)=Text.breakOn " {" line
    actual <- either (ioError . userError) pure (eitherDecodeStrict' (encodeUtf8 (Text.drop 1 payload)))
    require "logger serialized an unredacted payload" (actual==object ["name" .= String "document","token" .= String "[withheld]"])
  putStrLn "PASS every typed bus-log credential-redaction case and actual serialized output"
  where
    toJSONList=Array (Vector.singleton (object ["nested" .= object ["password" .= String "value"]]))
    shownList=Array (Vector.singleton (object ["nested" .= object ["password" .= String "[withheld]"]]))
