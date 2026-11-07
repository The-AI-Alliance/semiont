module Semiont.Errors (BusRequestError(..), TransportError(..), SessionError(..), SignInError(..)) where

import Control.Exception (Exception)
import Data.Aeson (Object)
import Data.Text (Text)
import Semiont.ErrorCodes (BusRequestCode, TransportCode, SessionCode, SignInCode)

data BusRequestError = BusRequestError
  { busRequestErrorCode :: BusRequestCode
  , busRequestErrorMessage :: Text
  , busRequestFailure :: Maybe Object
  } deriving (Eq)
instance Show BusRequestError where
  show failure = "BusRequestError " ++ show (busRequestErrorCode failure) ++ " " ++ show (busRequestErrorMessage failure)
instance Exception BusRequestError

data TransportError = TransportError
  { transportErrorCode :: TransportCode
  , transportErrorMessage :: Text
  , httpStatus :: Maybe Int
  , retryAfterMs :: Maybe Integer
  } deriving (Eq, Show)
instance Exception TransportError

-- | Session diagnostics contain no credential or raw issuer response.
data SessionError = SessionError
  { sessionErrorCode :: SessionCode
  , sessionErrorMessage :: Text
  , sessionErrorKbId :: Text
  } deriving (Eq, Show)
instance Exception SessionError

data SignInError = SignInError
  { signInErrorCode :: SignInCode
  , signInErrorMessage :: Text
  , signInStatus :: Maybe Int
  } deriving (Eq, Show)
instance Exception SignInError
