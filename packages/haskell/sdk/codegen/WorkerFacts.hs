{-# LANGUAGE OverloadedStrings #-}

module WorkerFacts (workerFacts) where

import Control.Monad (unless)
import qualified Data.ByteString as Bytes
import Data.Char (isAlphaNum)
import Data.List (nub)
import Data.Text (Text)
import qualified Data.Text as T
import Data.Text.Encoding (decodeUtf8')
import System.FilePath ((</>))
import TransportFacts (between)
import WorkerTypes (workerTypes)

quotedList :: Text -> Either String [Text]
quotedList source = do
  inner <- maybe (Left "worker channels need a literal array") Right
    (T.stripPrefix "[" (T.strip source) >>= T.stripSuffix "]")
  let entries = T.splitOn "," (T.strip inner)
      values = if T.null (T.strip (last entries)) then init entries else entries
  names <- traverse quoted values
  unless (not (null names) && length names == length (nub names)) (Left "empty or duplicate worker channel names")
  pure names
  where
    quoted written = do
      value <- maybe (Left "worker channels need quoted literal names") Right
        (T.stripPrefix "'" (T.strip written) >>= T.stripSuffix "'")
      unless (not (T.null value) && T.all (\c -> isAlphaNum c || c == ':' || c == '-') value)
        (Left "unsupported worker channel name")
      pure value

workerFacts :: FilePath -> (Text -> Text) -> IO [(FilePath, Text)]
workerFacts root member = do
  bytes <- Bytes.readFile (root </> "packages/typescript/sdk/src/claims.ts")
  source <- either (ioError . userError . show) pure (decodeUtf8' bytes)
  either (ioError . userError) pure $ do
    claim <- between "export const JOB_CLAIM_CHANNELS: readonly (keyof EventMap)[] = [" "\n];" source
    body <- maybe (Left "unsupported claim channel composition") Right (T.stripPrefix "...replyChannelsFor(" (T.strip claim))
    let (requests, extra) = T.breakOn ")," body
    unless (not (T.null extra)) (Left "claim channel composition has no reply list")
    claimOperations <- quotedList requests
    claimExtras <- quotedList ("[" <> T.drop 2 extra <> "]")
    commitOperations <- between "const COMMIT_OPERATIONS = " " as const satisfies readonly BusOperationKey[];" source >>= quotedList
    composition <- between "export const JOB_COMMIT_CHANNELS: readonly (keyof EventMap)[] = " ";\n" source
    unless (composition == "replyChannelsFor(COMMIT_OPERATIONS)") (Left "unsupported commit channel composition")
    let operations names = "replyChannelsFor [" <> T.intercalate ", " ["SomeOperation " <> member name <> "Operation" | name <- names] <> "]"
        code = T.unlines
          [ "-- Generated from packages/typescript/sdk/src/claims.ts and bus descriptors. Do not edit."
          , "module Semiont.Internal.Generated.WorkerChannels (jobClaimChannels, jobCommitChannels) where"
          , "import Data.Text (Text)"
          , "import Semiont.Bus (replyChannelsFor)"
          , "import Semiont.Channels"
          , "jobClaimChannels :: [Text]"
          , "jobClaimChannels = " <> operations claimOperations <> " ++ [" <> T.intercalate ", " ["channelName " <> member name | name <- claimExtras] <> "]"
          , "jobCommitChannels :: [Text]"
          , "jobCommitChannels = " <> operations commitOperations
          ]
    records <- workerTypes source
    pure (("generated/Semiont/Internal/Generated/WorkerChannels.hs", code) : records)
