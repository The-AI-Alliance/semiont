-- Generated from protocol/specs/src/client/timing.json; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Timing (RetryBudget(..), busRequestTimeoutMs, emitTimeoutMs, emitRetry, httpRequestTimeoutMs, requestRetryPauseMs, streamOpenTimeoutMs, reconnectMs, maxReconnectMs, degradedThresholdMs, lingerMs, seenEventIdsCount, reconnectDebounceMs, lazyRemoveMs, refreshRetry, refreshBeforeExpMs, minRefreshDelayMs, devicePollMs, deviceSlowDownMs, devicePollFloorMs, invalidationWindowMs, saveDebounceMs, maxStoredBytesCount, jobSilenceMs, jobStatusPollMs, generationStallFloorMs, generationStallPerTokenMs, generationStallAssumedTokensCount, delegateSilenceMs, jobClaimTimeoutMs, heldJobStallMs, heldJobStallCheckMs, markCommitTimeoutMs, generatedTextAsksCount, anchoredTextReaskMs, hoverDelayMs, searchDebounceMs, discoveryIntervalMs) where
import Control.Monad (unless)
import Data.Aeson (FromJSON(..), ToJSON(..), withObject, object, (.:), (.=))
import qualified Data.Aeson.KeyMap as KM
data RetryBudget = RetryBudget { retryAttempts :: Integer, retryInitialDelayMs :: Integer, retryMaxDelayMs :: Integer } deriving (Eq, Show)
instance ToJSON RetryBudget where toJSON value = object ["attempts" .= retryAttempts value, "initialDelayMs" .= retryInitialDelayMs value, "maxDelayMs" .= retryMaxDelayMs value]
instance FromJSON RetryBudget where
  parseJSON = withObject "RetryBudget" $ \fields -> do
    unless (all (`elem` ["attempts", "initialDelayMs", "maxDelayMs"]) (KM.keys fields)) (fail "Unknown retry budget member")
    value <- RetryBudget <$> fields .: "attempts" <*> fields .: "initialDelayMs" <*> fields .: "maxDelayMs"
    unless (all (>= 0) [retryAttempts value, retryInitialDelayMs value, retryMaxDelayMs value]) (fail "Negative retry budget member")
    pure value
busRequestTimeoutMs :: Integer
busRequestTimeoutMs = 30000

emitTimeoutMs :: Integer
emitTimeoutMs = 30000

emitRetry :: RetryBudget
emitRetry = RetryBudget { retryAttempts = 4, retryInitialDelayMs = 1000, retryMaxDelayMs = 4000 }

httpRequestTimeoutMs :: Integer
httpRequestTimeoutMs = 30000

requestRetryPauseMs :: Integer
requestRetryPauseMs = 300

streamOpenTimeoutMs :: Integer
streamOpenTimeoutMs = 30000

reconnectMs :: Integer
reconnectMs = 5000

maxReconnectMs :: Integer
maxReconnectMs = 60000

degradedThresholdMs :: Integer
degradedThresholdMs = 3000

lingerMs :: Integer
lingerMs = 1000

seenEventIdsCount :: Integer
seenEventIdsCount = 512

reconnectDebounceMs :: Integer
reconnectDebounceMs = 100

lazyRemoveMs :: Integer
lazyRemoveMs = 5000

refreshRetry :: RetryBudget
refreshRetry = RetryBudget { retryAttempts = 4, retryInitialDelayMs = 500, retryMaxDelayMs = 4000 }

refreshBeforeExpMs :: Integer
refreshBeforeExpMs = 300000

minRefreshDelayMs :: Integer
minRefreshDelayMs = 10000

devicePollMs :: Integer
devicePollMs = 5000

deviceSlowDownMs :: Integer
deviceSlowDownMs = 5000

devicePollFloorMs :: Integer
devicePollFloorMs = 1000

invalidationWindowMs :: Integer
invalidationWindowMs = 1000

saveDebounceMs :: Integer
saveDebounceMs = 50

maxStoredBytesCount :: Integer
maxStoredBytesCount = 2097152

jobSilenceMs :: Integer
jobSilenceMs = 10000

jobStatusPollMs :: Integer
jobStatusPollMs = 5000

generationStallFloorMs :: Integer
generationStallFloorMs = 120000

generationStallPerTokenMs :: Integer
generationStallPerTokenMs = 75

generationStallAssumedTokensCount :: Integer
generationStallAssumedTokensCount = 500

delegateSilenceMs :: Integer
delegateSilenceMs = 180000

jobClaimTimeoutMs :: Integer
jobClaimTimeoutMs = 10000

heldJobStallMs :: Integer
heldJobStallMs = 900000

heldJobStallCheckMs :: Integer
heldJobStallCheckMs = 60000

markCommitTimeoutMs :: Integer
markCommitTimeoutMs = 60000

generatedTextAsksCount :: Integer
generatedTextAsksCount = 8

anchoredTextReaskMs :: Integer
anchoredTextReaskMs = 5000

hoverDelayMs :: Integer
hoverDelayMs = 150

searchDebounceMs :: Integer
searchDebounceMs = 250

discoveryIntervalMs :: Integer
discoveryIntervalMs = 5000
