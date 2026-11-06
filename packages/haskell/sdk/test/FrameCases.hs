{-# LANGUAGE OverloadedStrings #-}
module FrameCases (frameCases) where

import Control.Monad (forM_, unless)
import Data.Aeson (Value(..), eitherDecodeStrict', encode, toJSON)
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Lazy as Lazy
import Data.Foldable (toList)
import qualified Data.Text as Text
import Data.Text.Encoding (decodeUtf8)
import qualified Semiont.Internal.Required as Required
import qualified Semiont.Internal.StreamFrame as Frame
import System.FilePath ((</>))

frameCases :: FilePath -> IO ()
frameCases root = do
  table <- Bytes.readFile (root </> "protocol/specs/src/bus/frame-cases.json") >>= either (ioError . userError) pure . eitherDecodeStrict'
  let member key (Object fields) = maybe (error ("missing frame case member " ++ show key)) id (KM.lookup key fields)
      member _ _ = error "frame case is not an object"
      rows = case member "cases" table of Array values -> toList values; _ -> error "frame cases is not an array"
      require label value = unless value (ioError (userError label))
  forM_ rows $ \row -> do
    fields <- case row of Object fields -> pure fields; _ -> ioError (userError "frame row is not an object")
    text <- case (KM.lookup "data" fields, KM.lookup "frame" fields) of
      (Just (String raw),Nothing) -> pure raw
      (Nothing,Just raw) -> pure (decodeUtf8 (Lazy.toStrict (encode raw)))
      _ -> ioError (userError "frame case must state frame or data")
    case Frame.readFrame text of
      Frame.Accepted frame -> do
        require "a malformed stream frame was accepted" (KM.lookup "refused" fields /= Just (Bool True))
        require "a stream frame changed on reading" (toJSON frame == member "frame" row)
      Frame.Rejected channel issue -> do
        require "a valid stream frame was refused" (KM.lookup "refused" fields == Just (Bool True))
        require "a frame refusal named the wrong member" (String (Required.member issue) == member "member" row)
        let reason = case Required.reason issue of Required.Lacks -> "lacks"; Required.Malformed -> "malformed"
            told = case channel of Nothing -> "failure-report"; Just _ -> "readers"
        require "a frame refusal named the wrong reason" (String reason == member "reason" row)
        require "a frame refusal found the wrong reader" (String told == member "told" row)
        require "a refusal with a channel accepted an empty one" (maybe True (not . Text.null) channel)
  putStrLn "PASS every shared stream frame case and refusal destination"
