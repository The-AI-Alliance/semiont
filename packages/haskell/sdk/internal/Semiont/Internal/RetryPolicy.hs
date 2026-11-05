{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.RetryPolicy (RetryRule(..), ruleName, retryable, repeatableMethod) where
import Data.Text (Text)
import qualified Data.Text as T

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
    && maybe False repeatableMethod method
retryable Refresh status _ = maybe True (\value -> value `elem` [408, 429] || value >= 500) status

repeatableMethod :: Text -> Bool
repeatableMethod method = T.toUpper method `elem` ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]

