-- Generated from protocol/specs/src/errors/codes.json; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.ErrorCodes (BusRequestCode(..), busRequestCode, parseBusRequestCode, busRequestCodeFromWire, ControlCode(..), controlCode, parseControlCode, JobCode(..), jobCode, parseJobCode, KbIdentityCode(..), kbIdentityCode, parseKbIdentityCode, SessionCode(..), sessionCode, parseSessionCode, SignInCode(..), signInCode, parseSignInCode, SpanRefusalCode(..), spanRefusalCode, parseSpanRefusalCode, TransportCode(..), transportCode, parseTransportCode, transportCodeFromStatus) where
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withText)
import Data.Text (Text)
data BusRequestCode = BusRequestTimeout | BusRequestRejected | BusRequestClosed | BusRequestNotFound | BusRequestUnsubscribed | BusRequestPeerUnavailable | BusRequestUnauthorized | BusRequestNonePending deriving (Eq, Ord, Show, Enum, Bounded)
busRequestCode :: BusRequestCode -> Text
busRequestCode BusRequestTimeout = "bus.timeout"
busRequestCode BusRequestRejected = "bus.rejected"
busRequestCode BusRequestClosed = "bus.closed"
busRequestCode BusRequestNotFound = "bus.not-found"
busRequestCode BusRequestUnsubscribed = "bus.unsubscribed"
busRequestCode BusRequestPeerUnavailable = "bus.peer-unavailable"
busRequestCode BusRequestUnauthorized = "bus.unauthorized"
busRequestCode BusRequestNonePending = "bus.none-pending"
parseBusRequestCode :: Text -> Maybe BusRequestCode
parseBusRequestCode value = case value of
  "bus.timeout" -> Just BusRequestTimeout
  "bus.rejected" -> Just BusRequestRejected
  "bus.closed" -> Just BusRequestClosed
  "bus.not-found" -> Just BusRequestNotFound
  "bus.unsubscribed" -> Just BusRequestUnsubscribed
  "bus.peer-unavailable" -> Just BusRequestPeerUnavailable
  "bus.unauthorized" -> Just BusRequestUnauthorized
  "bus.none-pending" -> Just BusRequestNonePending
  _ -> Nothing
instance ToJSON BusRequestCode where toJSON = String . busRequestCode
instance FromJSON BusRequestCode where parseJSON = withText "BusRequestCode" (\value -> maybe (fail "unknown error code") pure (parseBusRequestCode value))
busRequestCodeFromWire :: Maybe Text -> BusRequestCode
busRequestCodeFromWire value = case value of
  Just "not-found" -> BusRequestNotFound
  Just "peer-unavailable" -> BusRequestPeerUnavailable
  Just "unauthorized" -> BusRequestUnauthorized
  Just "none-pending" -> BusRequestNonePending
  _ -> BusRequestRejected

data ControlCode = ControlInvalidParams | ControlUnsupportedApiVersion | ControlInvalidRequest | ControlInvalidService | ControlInvalidValue | ControlUnknownSetting | ControlTargetRequired | ControlTargetAmbiguous | ControlRootNotFound | ControlRootNotRegistered | ControlStackNotRunning | ControlStackRunning | ControlStartInProgress | ControlRuntimeUnavailable | ControlDependencyUnavailable | ControlUnreachable | ControlConfirmationRequired | ControlUnreadableState | ControlAlreadySignedIn | ControlSignInFailed | ControlCancelled | ControlFailed deriving (Eq, Ord, Show, Enum, Bounded)
controlCode :: ControlCode -> Text
controlCode ControlInvalidParams = "control.invalid-params"
controlCode ControlUnsupportedApiVersion = "control.unsupported-api-version"
controlCode ControlInvalidRequest = "control.invalid-request"
controlCode ControlInvalidService = "control.invalid-service"
controlCode ControlInvalidValue = "control.invalid-value"
controlCode ControlUnknownSetting = "control.unknown-setting"
controlCode ControlTargetRequired = "control.target-required"
controlCode ControlTargetAmbiguous = "control.target-ambiguous"
controlCode ControlRootNotFound = "control.root-not-found"
controlCode ControlRootNotRegistered = "control.root-not-registered"
controlCode ControlStackNotRunning = "control.stack-not-running"
controlCode ControlStackRunning = "control.stack-running"
controlCode ControlStartInProgress = "control.start-in-progress"
controlCode ControlRuntimeUnavailable = "control.runtime-unavailable"
controlCode ControlDependencyUnavailable = "control.dependency-unavailable"
controlCode ControlUnreachable = "control.unreachable"
controlCode ControlConfirmationRequired = "control.confirmation-required"
controlCode ControlUnreadableState = "control.unreadable-state"
controlCode ControlAlreadySignedIn = "control.already-signed-in"
controlCode ControlSignInFailed = "control.sign-in-failed"
controlCode ControlCancelled = "control.cancelled"
controlCode ControlFailed = "control.failed"
parseControlCode :: Text -> Maybe ControlCode
parseControlCode value = case value of
  "control.invalid-params" -> Just ControlInvalidParams
  "control.unsupported-api-version" -> Just ControlUnsupportedApiVersion
  "control.invalid-request" -> Just ControlInvalidRequest
  "control.invalid-service" -> Just ControlInvalidService
  "control.invalid-value" -> Just ControlInvalidValue
  "control.unknown-setting" -> Just ControlUnknownSetting
  "control.target-required" -> Just ControlTargetRequired
  "control.target-ambiguous" -> Just ControlTargetAmbiguous
  "control.root-not-found" -> Just ControlRootNotFound
  "control.root-not-registered" -> Just ControlRootNotRegistered
  "control.stack-not-running" -> Just ControlStackNotRunning
  "control.stack-running" -> Just ControlStackRunning
  "control.start-in-progress" -> Just ControlStartInProgress
  "control.runtime-unavailable" -> Just ControlRuntimeUnavailable
  "control.dependency-unavailable" -> Just ControlDependencyUnavailable
  "control.unreachable" -> Just ControlUnreachable
  "control.confirmation-required" -> Just ControlConfirmationRequired
  "control.unreadable-state" -> Just ControlUnreadableState
  "control.already-signed-in" -> Just ControlAlreadySignedIn
  "control.sign-in-failed" -> Just ControlSignInFailed
  "control.cancelled" -> Just ControlCancelled
  "control.failed" -> Just ControlFailed
  _ -> Nothing
instance ToJSON ControlCode where toJSON = String . controlCode
instance FromJSON ControlCode where parseJSON = withText "ControlCode" (\value -> maybe (fail "unknown error code") pure (parseControlCode value))

data JobCode = JobFailed | JobCancelled | JobStalled deriving (Eq, Ord, Show, Enum, Bounded)
jobCode :: JobCode -> Text
jobCode JobFailed = "job.failed"
jobCode JobCancelled = "job.cancelled"
jobCode JobStalled = "job.stalled"
parseJobCode :: Text -> Maybe JobCode
parseJobCode value = case value of
  "job.failed" -> Just JobFailed
  "job.cancelled" -> Just JobCancelled
  "job.stalled" -> Just JobStalled
  _ -> Nothing
instance ToJSON JobCode where toJSON = String . jobCode
instance FromJSON JobCode where parseJSON = withText "JobCode" (\value -> maybe (fail "unknown error code") pure (parseJobCode value))

data KbIdentityCode = KbIdentityUnreachable | KbIdentityNotReported deriving (Eq, Ord, Show, Enum, Bounded)
kbIdentityCode :: KbIdentityCode -> Text
kbIdentityCode KbIdentityUnreachable = "unreachable"
kbIdentityCode KbIdentityNotReported = "not-reported"
parseKbIdentityCode :: Text -> Maybe KbIdentityCode
parseKbIdentityCode value = case value of
  "unreachable" -> Just KbIdentityUnreachable
  "not-reported" -> Just KbIdentityNotReported
  _ -> Nothing
instance ToJSON KbIdentityCode where toJSON = String . kbIdentityCode
instance FromJSON KbIdentityCode where parseJSON = withText "KbIdentityCode" (\value -> maybe (fail "unknown error code") pure (parseKbIdentityCode value))

data SessionCode = SessionConstructFailed | SessionAuthFailed | SessionRefreshExhausted | SessionCredentialRefused deriving (Eq, Ord, Show, Enum, Bounded)
sessionCode :: SessionCode -> Text
sessionCode SessionConstructFailed = "session.construct-failed"
sessionCode SessionAuthFailed = "session.auth-failed"
sessionCode SessionRefreshExhausted = "session.refresh-exhausted"
sessionCode SessionCredentialRefused = "session.credential-refused"
parseSessionCode :: Text -> Maybe SessionCode
parseSessionCode value = case value of
  "session.construct-failed" -> Just SessionConstructFailed
  "session.auth-failed" -> Just SessionAuthFailed
  "session.refresh-exhausted" -> Just SessionRefreshExhausted
  "session.credential-refused" -> Just SessionCredentialRefused
  _ -> Nothing
instance ToJSON SessionCode where toJSON = String . sessionCode
instance FromJSON SessionCode where parseJSON = withText "SessionCode" (\value -> maybe (fail "unknown error code") pure (parseSessionCode value))

data SignInCode = SignInNoIssuer | SignInDiscovery | SignInNoPending | SignInState | SignInDenied | SignInExpired | SignInAborted | SignInExchange deriving (Eq, Ord, Show, Enum, Bounded)
signInCode :: SignInCode -> Text
signInCode SignInNoIssuer = "no-issuer"
signInCode SignInDiscovery = "discovery"
signInCode SignInNoPending = "no-pending"
signInCode SignInState = "state"
signInCode SignInDenied = "denied"
signInCode SignInExpired = "expired"
signInCode SignInAborted = "aborted"
signInCode SignInExchange = "exchange"
parseSignInCode :: Text -> Maybe SignInCode
parseSignInCode value = case value of
  "no-issuer" -> Just SignInNoIssuer
  "discovery" -> Just SignInDiscovery
  "no-pending" -> Just SignInNoPending
  "state" -> Just SignInState
  "denied" -> Just SignInDenied
  "expired" -> Just SignInExpired
  "aborted" -> Just SignInAborted
  "exchange" -> Just SignInExchange
  _ -> Nothing
instance ToJSON SignInCode where toJSON = String . signInCode
instance FromJSON SignInCode where parseJSON = withText "SignInCode" (\value -> maybe (fail "unknown error code") pure (parseSignInCode value))

data SpanRefusalCode = SpanRefusalSpanOutOfRange | SpanRefusalExactMismatch | SpanRefusalPrefixMismatch | SpanRefusalSuffixMismatch | SpanRefusalNothingLocated | SpanRefusalExactNotCovered | SpanRefusalItemOutOfRange deriving (Eq, Ord, Show, Enum, Bounded)
spanRefusalCode :: SpanRefusalCode -> Text
spanRefusalCode SpanRefusalSpanOutOfRange = "span-out-of-range"
spanRefusalCode SpanRefusalExactMismatch = "exact-mismatch"
spanRefusalCode SpanRefusalPrefixMismatch = "prefix-mismatch"
spanRefusalCode SpanRefusalSuffixMismatch = "suffix-mismatch"
spanRefusalCode SpanRefusalNothingLocated = "nothing-located"
spanRefusalCode SpanRefusalExactNotCovered = "exact-not-covered"
spanRefusalCode SpanRefusalItemOutOfRange = "item-out-of-range"
parseSpanRefusalCode :: Text -> Maybe SpanRefusalCode
parseSpanRefusalCode value = case value of
  "span-out-of-range" -> Just SpanRefusalSpanOutOfRange
  "exact-mismatch" -> Just SpanRefusalExactMismatch
  "prefix-mismatch" -> Just SpanRefusalPrefixMismatch
  "suffix-mismatch" -> Just SpanRefusalSuffixMismatch
  "nothing-located" -> Just SpanRefusalNothingLocated
  "exact-not-covered" -> Just SpanRefusalExactNotCovered
  "item-out-of-range" -> Just SpanRefusalItemOutOfRange
  _ -> Nothing
instance ToJSON SpanRefusalCode where toJSON = String . spanRefusalCode
instance FromJSON SpanRefusalCode where parseJSON = withText "SpanRefusalCode" (\value -> maybe (fail "unknown error code") pure (parseSpanRefusalCode value))

data TransportCode = TransportUnauthorized | TransportForbidden | TransportNotFound | TransportConflict | TransportBadRequest | TransportUnprocessable | TransportRateLimited | TransportUnavailable | TransportError deriving (Eq, Ord, Show, Enum, Bounded)
transportCode :: TransportCode -> Text
transportCode TransportUnauthorized = "unauthorized"
transportCode TransportForbidden = "forbidden"
transportCode TransportNotFound = "not-found"
transportCode TransportConflict = "conflict"
transportCode TransportBadRequest = "bad-request"
transportCode TransportUnprocessable = "unprocessable"
transportCode TransportRateLimited = "rate-limited"
transportCode TransportUnavailable = "unavailable"
transportCode TransportError = "error"
parseTransportCode :: Text -> Maybe TransportCode
parseTransportCode value = case value of
  "unauthorized" -> Just TransportUnauthorized
  "forbidden" -> Just TransportForbidden
  "not-found" -> Just TransportNotFound
  "conflict" -> Just TransportConflict
  "bad-request" -> Just TransportBadRequest
  "unprocessable" -> Just TransportUnprocessable
  "rate-limited" -> Just TransportRateLimited
  "unavailable" -> Just TransportUnavailable
  "error" -> Just TransportError
  _ -> Nothing
instance ToJSON TransportCode where toJSON = String . transportCode
instance FromJSON TransportCode where parseJSON = withText "TransportCode" (\value -> maybe (fail "unknown error code") pure (parseTransportCode value))
transportCodeFromStatus :: Int -> TransportCode
transportCodeFromStatus status
  | status == 401 = TransportUnauthorized
  | status == 403 = TransportForbidden
  | status == 404 = TransportNotFound
  | status == 409 = TransportConflict
  | status == 400 = TransportBadRequest
  | status == 422 = TransportUnprocessable
  | status == 429 = TransportRateLimited
  | status >= 500 = TransportUnavailable
  | otherwise = TransportError
