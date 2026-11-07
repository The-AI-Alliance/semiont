-- Generated from protocol/specs/src/errors/codes.json; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.ErrorRoundTrip (roundTripError) where
import Data.Aeson (Value, parseJSON, toJSON)
import Data.Aeson.Types (parseEither)
import Data.Text (Text)
import Semiont.ErrorCodes
roundTripError :: Text -> Value -> Either String Value
roundTripError family value = case family of
  "busRequest" -> toJSON <$> (parseEither parseJSON value :: Either String BusRequestCode)
  "job" -> toJSON <$> (parseEither parseJSON value :: Either String JobCode)
  "kbIdentity" -> toJSON <$> (parseEither parseJSON value :: Either String KbIdentityCode)
  "session" -> toJSON <$> (parseEither parseJSON value :: Either String SessionCode)
  "signIn" -> toJSON <$> (parseEither parseJSON value :: Either String SignInCode)
  "spanRefusal" -> toJSON <$> (parseEither parseJSON value :: Either String SpanRefusalCode)
  "transport" -> toJSON <$> (parseEither parseJSON value :: Either String TransportCode)
  _ -> Left "unknown error-code family"
