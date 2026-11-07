{-# LANGUAGE OverloadedStrings #-}

module WorkerCases (workerCases) where

import Control.Monad (forM_, unless)
import Data.Aeson (Value, eitherDecodeStrict', parseJSON, withObject, (.:))
import qualified Data.Aeson.KeyMap as KM
import Data.Aeson.Types (Parser, parseEither)
import qualified Data.ByteString as Bytes
import Data.Text (Text)
import qualified Data.Text as T
import Semiont.Claims (willRetryAfter)
import Semiont.JobFilter (jobMatchesFilter)
import Semiont.Types (FailureClass, JobFilter, JobMetadata(..))
import System.FilePath ((</>))

readCases :: FilePath -> (Value -> Parser row) -> IO [row]
readCases path parser = do
  table <- Bytes.readFile path >>= either (ioError . userError) pure . eitherDecodeStrict'
  rows <- either (ioError . userError) pure (parseEither (withObject "case table" (.: "cases")) table)
  unless (not (null rows)) (ioError (userError (path ++ " has no cases")))
  traverse (either (ioError . userError) pure . parseEither parser) rows

filterCase :: Value -> Parser (Text, JobFilter, Value, Bool)
filterCase = withObject "filter case" $ \row -> do
  unless (all (`elem` ["why", "filter", "job", "matches"]) (KM.keys row)) (fail "unhandled job-filter case fact")
  (,,,) <$> row .: "why" <*> row .: "filter" <*> row .: "job" <*> row .: "matches"

retryCase :: Value -> Parser (Text, Integer, Integer, Maybe FailureClass, Bool)
retryCase = withObject "retry case" $ \row -> do
  unless (all (`elem` ["why", "retryCount", "maxRetries", "failureClass", "retries"]) (KM.keys row)) (fail "unhandled job-retry case fact")
  -- Missing is unclassified; an explicit null is not a FailureClass.
  failure <- traverse parseJSON (KM.lookup "failureClass" row)
  (,,,,) <$> row .: "why" <*> row .: "retryCount" <*> row .: "maxRetries" <*> pure failure <*> row .: "retries"

workerCases :: FilePath -> JobMetadata -> IO ()
workerCases root metadata = do
  filters <- readCases (root </> "protocol/specs/src/jobs/filter-cases.json") filterCase
  forM_ filters $ \(why, filterValue, job, expected) ->
    unless (jobMatchesFilter filterValue job == expected) (ioError (userError ("job filter: " ++ T.unpack why)))
  retries <- readCases (root </> "protocol/specs/src/jobs/retry-cases.json") retryCase
  forM_ retries $ \(why, retryCount, maxRetries, failure, expected) -> do
    let budget = metadata { jobMetadataRetryCount = retryCount, jobMetadataMaxRetries = maxRetries }
    unless (willRetryAfter budget failure == expected) (ioError (userError ("job retry: " ++ T.unpack why)))
  putStrLn ("PASS all " ++ show (length filters) ++ " job-filter and " ++ show (length retries) ++ " job-retry cases")
