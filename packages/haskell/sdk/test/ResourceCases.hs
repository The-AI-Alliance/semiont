{-# LANGUAGE OverloadedStrings #-}
module ResourceCases (resourceCases) where

import Control.Monad (forM_, unless)
import Data.Aeson (Value(..), eitherDecodeStrict', toJSON, fromJSON, Result(..))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import Data.Foldable (toList)
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Semiont.Internal.Required as Required
import qualified Semiont.Resources as Resources
import Semiont.Types (ResourceDescriptor)
import System.FilePath ((</>))

member :: Text -> Value -> Value
member name (Object fields) = maybe (error ("missing resource case member " ++ Text.unpack name)) id (KM.lookup (Key.fromText name) fields)
member _ _ = error "resource case is not an object"
require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))
resourceCases :: FilePath -> IO ()
resourceCases root = do
  table <- Bytes.readFile (root </> "protocol/specs/src/resources/reader-cases.json") >>= either (ioError . userError) pure . eitherDecodeStrict'
  rows <- case member "cases" table of Array values -> pure (toList values); _ -> ioError (userError "resource cases is not an array")
  forM_ rows $ \row -> do
    let raw = member "resource" row
        refused = case row of Object fields -> KM.lookup "refused" fields == Just (Bool True); _ -> False
    case Required.faultOf "ResourceDescriptor" raw of
      Just issue -> do
        require ("valid resource refused: " ++ show row) refused
        require "resource refusal names the wrong member" (String (Required.member issue) == member "member" row)
        let reason = case Required.reason issue of Required.Lacks -> "lacks"; Required.Malformed -> "malformed"
        require "resource refusal names the wrong reason" (String reason == member "reason" row)
      Nothing -> do
        require ("malformed resource passed its shared shape: " ++ show row) (not refused)
        resource <- case fromJSON raw of Error message -> ioError (userError message); Success value -> pure (value :: ResourceDescriptor)
        let expected key = case row of Object fields -> maybe Null id (KM.lookup key fields); _ -> error "resource row is not an object"
        require "resource primary representation differs" (toJSON (Resources.getPrimaryRepresentation resource) == expected "primaryRepresentation")
        require "resource primary media type differs" (toJSON (Resources.getPrimaryMediaType resource) == expected "primaryMediaType")
        require "resource entity types differ" (toJSON (Resources.getResourceEntityTypes resource) == member "entityTypes" row)
  putStrLn "PASS every resource reader case, including ordered common member/reason refusals"
