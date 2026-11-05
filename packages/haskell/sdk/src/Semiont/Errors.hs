module Semiont.Errors (BusRequestError(..), TransportError(..)) where

import Control.Exception (Exception)
import Data.Aeson (Object)
import Data.Text (Text)
import Semiont.ErrorCodes (BusRequestCode, TransportCode)

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
