-- Generated from TRANSPORT-HTTP.md, bus/registry.json and identifiers/kinds.json. Do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Transport.Facts (ConnectionState(..), connectionStateName, connectionTransitions, traceField, traceCarrierFields, userField) where
import Data.Text (Text)
data ConnectionState = Initial | Connecting | Open | Reconnecting | Degraded | Unauthenticated | Closed deriving (Eq, Ord, Show, Enum, Bounded)
connectionStateName :: ConnectionState -> Text
connectionStateName Initial = "initial"
connectionStateName Connecting = "connecting"
connectionStateName Open = "open"
connectionStateName Reconnecting = "reconnecting"
connectionStateName Degraded = "degraded"
connectionStateName Unauthenticated = "unauthenticated"
connectionStateName Closed = "closed"
connectionTransitions :: ConnectionState -> [ConnectionState]
connectionTransitions Initial = [Connecting, Unauthenticated, Closed]
connectionTransitions Connecting = [Open, Reconnecting, Unauthenticated, Closed]
connectionTransitions Open = [Reconnecting, Closed]
connectionTransitions Reconnecting = [Connecting, Degraded, Unauthenticated, Closed]
connectionTransitions Degraded = [Connecting, Unauthenticated, Closed]
connectionTransitions Unauthenticated = [Connecting, Closed]
connectionTransitions Closed = []
traceField :: Text
traceField = "_trace"
traceCarrierFields :: [Text]
traceCarrierFields = ["traceparent", "tracestate"]
userField :: Text
userField = "_userId"
