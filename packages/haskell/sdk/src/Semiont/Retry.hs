{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE OverloadedStrings #-}

-- | Retry decisions are held to protocol/specs/src/retry/cases.json. The
-- caller supplies monotonic time, interruptible waits, and non-secret jitter.
module Semiont.Retry
  ( RetryRule(..), ruleName, retryable, retryAfterMs
  , RetryOptions(..), RetryConfigurationError(..), retryWithBackoff
  ) where

import Control.Exception (Exception, SomeAsyncException, fromException, throwIO, toException, try)
import Control.Monad (unless, when)
import Data.Text (Text)
import qualified Data.Text as T
import Semiont.Timing (RetryBudget(..))

data RetryRule = Boot | Job | Transport | Refresh deriving (Eq, Ord, Show, Enum, Bounded)

ruleName :: RetryRule -> Text
ruleName Boot = "boot"
ruleName Job = "job"
ruleName Transport = "transport"
ruleName Refresh = "refresh"

retryable :: RetryRule -> Maybe Int -> Maybe Text -> Bool
retryable Boot status _ = status `elem` map Just [429, 503, 504]
retryable Job status _ = maybe False (\value -> value `elem` [408, 429] || value >= 500) status
retryable Transport status method =
  status `elem` map Just [408, 413, 429, 500, 502, 503, 504]
    && fmap T.toUpper method `elem` map Just ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]
retryable Refresh status _ = maybe True (\value -> value `elem` [408, 429] || value >= 500) status

retryAfterMs :: Maybe Text -> Maybe Integer
retryAfterMs header = do
  value <- T.strip <$> header
  if T.null value || not (T.all (\digit -> digit >= '0' && digit <= '9') value) then Nothing
    else Just (1000 * T.foldl' (\total digit -> total * 10 + fromIntegral (fromEnum digit - fromEnum '0')) 0 value)

data RetryOptions = RetryOptions
  { retryNow :: IO Integer
  -- ^ Monotonic nanoseconds in the same coordinate system as 'retryWaitUntil'.
  , retryWaitUntil :: Integer -> IO ()
  -- ^ An interruptible wait until the absolute monotonic nanosecond deadline.
  , retryRandom :: IO Double
  -- ^ A non-secret draw from 0 to 1, used for equal jitter.
  }

data RetryConfigurationError = InvalidRetryBudget | InvalidJitter | InvalidRetryAfter deriving (Eq, Show)
instance Exception RetryConfigurationError

retryWithBackoff :: forall failure value. Exception failure
  => RetryOptions -> RetryBudget -> (failure -> Bool) -> (failure -> Maybe Integer) -> IO value -> IO value
retryWithBackoff options budget accepts retryAfter action = do
  when (retryAttempts budget < 1 || retryInitialDelayMs budget < 0 || retryMaxDelayMs budget < retryInitialDelayMs budget)
    (throwIO InvalidRetryBudget)
  run 1 (retryInitialDelayMs budget)
  where
    run made cap = do
      outcome <- try action :: IO (Either failure value)
      case outcome of
        Right value -> pure value
        Left failure -> do
          case fromException (toException failure) :: Maybe SomeAsyncException of
            Just _ -> throwIO failure
            Nothing -> pure ()
          if made >= retryAttempts budget || not (accepts failure) then throwIO failure else do
            draw <- retryRandom options
            unless (draw >= 0 && draw <= 1) (throwIO InvalidJitter)
            let stated = retryAfter failure
            when (maybe False (< 0) stated) (throwIO InvalidRetryAfter)
            let jitter = fromInteger cap * (1 + toRational draw) / 2
                delay = ceiling (max jitter (fromInteger (maybe 0 id stated)) * 1000000)
            now <- retryNow options
            retryWaitUntil options (now + delay)
            run (made + 1) (min (retryMaxDelayMs budget) (cap * 2))
