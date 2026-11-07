{-# LANGUAGE OverloadedStrings #-}
module DriverProtocol (Misuse(..), need, decode, optional, failure, answerValue, now, waitUntil) where
import Control.Concurrent.Async (AsyncCancelled(..))
import qualified Semiont.Worker as Worker
import Control.Concurrent (threadDelay)
import Control.Exception (Exception, SomeException, fromException, throwIO)
import Control.Monad (when)
import Data.Aeson hiding (decode)
import qualified Data.Aeson.KeyMap as KM
import GHC.Clock (getMonotonicTimeNSec)
import qualified Semiont.ErrorCodes as Code
import qualified Semiont.Delegation as Delegation
import Semiont.Errors
data Misuse = Misuse String deriving Show
instance Exception Misuse


need :: FromJSON value => Object -> Key -> IO value
need fields key = case KM.lookup key fields of
  Nothing -> throwIO (Misuse ("Missing argument " ++ show key))
  Just value -> decode value

decode :: FromJSON value => Value -> IO value
decode value = case fromJSON value of Error reason -> throwIO (Misuse reason); Success result -> pure result

optional :: FromJSON value => Object -> Key -> IO (Maybe value)
optional fields key = traverse decode (KM.lookup key fields)


failure :: SomeException -> Maybe Value
failure exception
  | Just problem <- fromException exception :: Maybe TransportError = Just $ object
      (["code" .= Code.transportCode (transportErrorCode problem), "detail" .= transportErrorMessage problem]
        ++ maybe [] (\status -> ["status" .= status]) (httpStatus problem))
  | Just problem <- fromException exception :: Maybe BusRequestError = Just $ object
      ["code" .= Code.busRequestCode (busRequestErrorCode problem), "detail" .= busRequestErrorMessage problem]
  | Just problem <- fromException exception :: Maybe Delegation.JobError = Just $ object
      (["code" .= Code.jobCode (Delegation.jobErrorCode problem), "detail" .= show problem]
        ++ maybe [] (\kind -> ["failureClass" .= kind]) (Delegation.jobErrorFailureClass problem))
  | otherwise = Nothing


now :: IO Integer
now = toInteger <$> getMonotonicTimeNSec

waitUntil :: Integer -> IO ()
waitUntil due = do
  current <- now
  when (current < due) $ do
    threadDelay (fromInteger (min (toInteger (maxBound :: Int)) ((due - current + 999) `div` 1000)))
    waitUntil due


answerValue :: Integer -> Either SomeException Value -> Either SomeException Value
answerValue identifier outcome = case outcome of
  Right value -> Right (object ["id" .= identifier,"ok" .= value])
  Left problem
    | Just issue <- (fromException problem :: Maybe Worker.WorkerError) -> Right (object ["id" .= identifier,"misuse" .= show issue])
    | Just (Misuse reason) <- fromException problem -> Right (object ["id" .= identifier,"misuse" .= reason])
    | Just AsyncCancelled <- fromException problem -> Right (object ["id" .= identifier,"abandoned" .= True])
    | Just value <- failure problem -> Right (object ["id" .= identifier,"error" .= value])
    | otherwise -> Left problem
