{-# LANGUAGE ScopedTypeVariables #-}
-- | Failures as the SDK meets them: what one says of itself, in a message the
-- SDK says, and one the action met told from the cancellation of the thread
-- that ran it.
module Semiont.Internal.Exception (exceptionMessage, trySync) where

import Control.Exception (SomeAsyncException, SomeException(..), displayException, fromException, throwIO, try)
import Data.Text (Text)
import qualified Data.Text as Text

-- | What the failure says, without the context GHC attaches to it as it is
-- thrown, its backtrace among it.
exceptionMessage :: SomeException -> Text
exceptionMessage (SomeException failure) = Text.pack (displayException failure)

-- | What the action gives, or the failure it met. An asynchronous exception,
-- a cancellation among them, is the thread's, not the action's: it is raised
-- again.
trySync :: IO value -> IO (Either SomeException value)
trySync action = do
  outcome <- try action
  case outcome of
    Left problem | Just (_ :: SomeAsyncException) <- fromException problem -> throwIO problem
    _ -> pure outcome
