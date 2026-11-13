{-# LANGUAGE OverloadedStrings #-}
module LifetimeCases (lifetimeCases) where

import Control.Concurrent.Async (Async, AsyncCancelled, async, cancel, waitCatch)
import Control.Concurrent.STM
import Control.Exception (finally, fromException, try)
import Control.Monad (unless)
import qualified Semiont.Internal.Lifetime as Lifetime
import Semiont.Errors (BusRequestError(..))
import Semiont.ErrorCodes (BusRequestCode(BusRequestClosed))
import System.Timeout (timeout)

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))

lifetimeCases :: IO ()
lifetimeCases = do
  outcome <- timeout 5000000 $ do
    life <- Lifetime.newLifetime "test lifetime is closed"
    entered <- newEmptyTMVarIO
    cleanup <- newEmptyTMVarIO
    release <- newEmptyTMVarIO
    child <- Lifetime.start life ((atomically (putTMVar entered ()) >> atomically retry)
      `finally` (atomically (putTMVar cleanup ()) >> atomically (takeTMVar release)))
    atomically (takeTMVar entered)
    closer <- async (Lifetime.close life)
    atomically (takeTMVar cleanup)
    cancel closer
    atomically (putTMVar release ())
    Lifetime.close life
    result <- waitCatch child
    require "close did not cancel and join its owned child" (either (const True) (const False) result)
    refused <- try (Lifetime.start life (pure ())) :: IO (Either BusRequestError (Async ()))
    require "closed lifetime started new work" (either ((== BusRequestClosed) . busRequestErrorCode) (const False) refused)

    self <- Lifetime.newLifetime "test lifetime is closed"
    ended <- try (Lifetime.run self (Lifetime.close self)) :: IO (Either BusRequestError ())
    require "self-close did not terminate its operation" (either ((== BusRequestClosed) . busRequestErrorCode) (const False) ended)
    Lifetime.close self

    overtaken <- Lifetime.newLifetime "test lifetime is closed"
    quiet <- Lifetime.runUntilClosed overtaken (Lifetime.close overtaken)
    require "an operation its lifetime's close overtook did not end with nothing" (quiet == Nothing)
    Lifetime.close overtaken

    abandoned <- Lifetime.newLifetime "test lifetime is closed"
    running <- newEmptyTMVarIO
    released <- newEmptyTMVarIO
    request <- async (Lifetime.run abandoned ((atomically (putTMVar running ()) >> atomically retry)
      `finally` atomically (putTMVar released ())))
    atomically (takeTMVar running)
    cancel request
    atomically (takeTMVar released)
    resultAfterCancel <- waitCatch request
    require "caller cancellation changed its exception" (case resultAfterCancel of
      Left exception -> case fromException exception :: Maybe AsyncCancelled of Just _ -> True; Nothing -> False
      Right _ -> False)
    Lifetime.close abandoned
  require "HTTP lifetime cleanup exceeded its liveness guard" (outcome == Just ())
  putStrLn "PASS HTTP lifetime self-close, caller cancellation and abandoned close waiters"
