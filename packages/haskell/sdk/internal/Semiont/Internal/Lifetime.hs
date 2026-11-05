{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Lifetime (Lifetime, newLifetime, start, run, close, isClosed) where

import Control.Concurrent (ThreadId, myThreadId)
import Control.Concurrent.Async (Async, AsyncCancelled(..), asyncThreadId, cancel, mapConcurrently_, race)
import Control.Concurrent.STM
import Control.Exception (SomeException, finally, fromException, mask, throwIO, try)
import Control.Monad (unless, void, when)
import qualified Data.Map.Strict as Map
import OpenTelemetry.Context.ThreadLocal.Propagation (propagateContext, tracedAsync)
import Semiont.ErrorCodes (BusRequestCode(BusRequestClosed))
import Semiont.Errors (BusRequestError(..))

data Lifetime = Lifetime (TVar Bool) (TVar Integer) (TVar (Map.Map Integer (ThreadId, IO ()))) (TMVar (Either SomeException ()))

newLifetime :: IO Lifetime
newLifetime = atomically $ Lifetime <$> newTVar False <*> newTVar 0 <*> newTVar Map.empty <*> newEmptyTMVar

isClosed :: Lifetime -> STM Bool
isClosed (Lifetime closed _ _ _) = readTVar closed

closedError :: BusRequestError
closedError = BusRequestError BusRequestClosed "HTTP transport is closed" Nothing

start :: Lifetime -> IO result -> IO (Async result)
start lifetime@(Lifetime _ counter children _) action = mask $ \restore -> do
  key <- atomically $ do
    over <- isClosed lifetime
    when over (throwSTM closedError)
    key <- readTVar counter
    writeTVar counter (key + 1)
    pure key
  gate <- newEmptyTMVarIO
  child <- tracedAsync ((atomically (takeTMVar gate) >> restore action)
    `finally` atomically (modifyTVar' children (Map.delete key)))
  accepted <- atomically $ do
    over <- isClosed lifetime
    if over then pure False else do
      modifyTVar' children (Map.insert key (asyncThreadId child, cancel child))
      putTMVar gate ()
      pure True
  if accepted then pure child else cancel child >> throwIO closedError

run :: Lifetime -> IO result -> IO result
run lifetime@(Lifetime _ counter children _) action = mask $ \restore -> do
  caller <- myThreadId
  completed <- newEmptyTMVarIO
  inherited <- propagateContext (try action)
  key <- atomically $ do
    over <- isClosed lifetime
    when over (throwSTM closedError)
    key <- readTVar counter
    writeTVar counter (key + 1)
    modifyTVar' children (Map.insert key (caller, atomically (readTMVar completed)))
    pure key
  let work = do
        result <- race inherited (atomically (isClosed lifetime >>= check))
        case result of
          Right () -> throwIO closedError
          Left (Right answer) -> pure answer
          Left (Left problem) -> do
            over <- atomically (isClosed lifetime)
            case fromException problem :: Maybe AsyncCancelled of
              Just _ | over -> throwIO closedError
              _ -> throwIO (problem :: SomeException)
  restore work `finally` atomically (modifyTVar' children (Map.delete key) >> putTMVar completed ())

close :: Lifetime -> IO ()
close (Lifetime closed _ children ended) = mask $ \restore -> do
  caller <- myThreadId
  (first, owned, actions) <- atomically $ do
    already <- readTVar closed
    writeTVar closed True
    active <- Map.elems <$> readTVar children
    let stops = Map.fromListWith (\_ old -> old) active
    pure (not already, Map.member caller stops, Map.elems stops)
  when first $ void $ tracedAsync $ do
    outcome <- try (mapConcurrently_ id actions)
    atomically (putTMVar ended outcome)
  unless owned (restore (atomically (readTMVar ended)) >>= either throwIO pure)
