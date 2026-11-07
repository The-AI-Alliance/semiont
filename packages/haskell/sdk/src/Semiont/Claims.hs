module Semiont.Claims (jobClaimChannels, jobCommitChannels, willRetryAfter) where

import Semiont.Internal.Generated.WorkerChannels (jobClaimChannels, jobCommitChannels)
import Semiont.Types (FailureClass(..), JobMetadata(..))

-- The budget is the record's before applying this failure.
willRetryAfter :: JobMetadata -> Maybe FailureClass -> Bool
willRetryAfter budget failure = retryable failure && jobMetadataRetryCount budget < jobMetadataMaxRetries budget
  where
    retryable Nothing = True
    retryable (Just FailureClassTransient) = True
    retryable (Just FailureClassDeterministic) = False
    retryable (Just FailureClassWithheld) = False
