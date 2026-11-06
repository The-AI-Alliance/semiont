{-# LANGUAGE OverloadedStrings #-}

module GatewayCases (gatewayCases) where

import Control.Monad (forM_, unless)
import Data.Aeson (Value, eitherDecodeStrict', withObject, (.:))
import Data.Aeson.Types (Parser, parseEither)
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.Text as T
import Semiont.Gateway (gatewayUrl)
import Semiont.HostName (isValidHostname)
import Semiont.Types (HttpEndpoint(..))
import System.FilePath ((</>))

gatewayCases :: FilePath -> IO ()
gatewayCases root = do
  table <- Bytes.readFile (root </> "protocol/specs/src/session/gateway-url-cases.json")
    >>= either (ioError . userError) pure . eitherDecodeStrict'
  rows <- either (ioError . userError) pure (parseEither
    (withObject "gateway URL table" (\fields -> fields .: "cases" :: Parser [Value])) table)
  unless (not (null rows)) (ioError (userError "gateway URL table has no cases"))
  forM_ rows $ \row -> do
    (why, endpoint, expected) <- either (ioError . userError) pure $ flip parseEither row $ withObject "gateway URL case" $ \fields -> do
      unless (all (`elem` ["why", "endpoint", "origin"]) (KM.keys fields)) (fail "unhandled gateway URL case fact")
      (,,) <$> fields .: "why" <*> fields .: "endpoint" <*> fields .: "origin"
    let actual = either (const Nothing) Just (gatewayUrl endpoint)
    unless (actual == expected) (ioError (userError ("gateway URL: " ++ T.unpack why)))
    unless (isValidHostname (httpEndpointHost endpoint) == maybe False (const True) expected)
      (ioError (userError ("gateway hostname: " ++ T.unpack why)))
  putStrLn ("PASS all " ++ show (length rows) ++ " gateway URL and hostname cases")
