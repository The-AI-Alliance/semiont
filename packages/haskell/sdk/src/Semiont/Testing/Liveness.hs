{-# LANGUAGE OverloadedStrings #-}
-- | Executable L1/L2 settlement and L3 delivery axioms over real subjects.
module Semiont.Testing.Liveness
  ( LivenessScenario(..), LivenessSpec(..), DeliverySubject(..), DeliveryOp(..)
  , faultActions, faultSchedules, deliveryOps, assertLivenessAxioms, assertExactlyOnceDelivery
  ) where

import Control.Concurrent.Async (async, cancel, poll)
import Control.Exception (bracket)
import Control.Monad (forM_, unless, when)
import Data.Maybe (isJust)
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Data.Set as Set
import qualified Test.QuickCheck as QC
import Semiont.Internal.Generated.Testing
import Semiont.Retry (RetryOptions(..))
import qualified Semiont.Testing.Transport as Faulty
import qualified Semiont.Channels as Channels
import qualified Semiont.Transport as Transport

deliveryOps :: Int -> QC.Gen [DeliveryOp]
deliveryOps longest
  | longest<1=error "delivery interleavings require a positive maximum length"
  | otherwise=do
      count <- QC.chooseInt (1,longest)
      ops <- QC.vectorOf count (QC.elements [minBound..maxBound])
      pure (if Write `elem` ops then ops else ops++[Write])

data DeliverySubject = DeliverySubject
  { write :: Text -> IO ()
  , transition :: IO ()
  , delivered :: IO [Text]
  }

assertLivenessAxioms :: QC.Args -> LivenessSpec -> IO ()
assertLivenessAxioms args spec = do
  when (livenessSpecTimeoutMs spec<=0 || livenessSpecRetryBudget spec<0 || livenessSpecCases spec<1)
    (ioError (userError "liveness needs a positive timeout/case count and a nonnegative retry budget"))
  result <- QC.quickCheckWithResult args {QC.maxSuccess=livenessSpecCases spec} $
    QC.forAll (livenessSpecSchedules spec) $ \schedule -> QC.ioProperty $ do
      let clock=livenessClock spec
          delay=sum [ms|Delay ms<-schedule]
          bound=(livenessSpecTimeoutMs spec * (1+livenessSpecRetryBudget spec)+delay)*slack
      bracket (Faulty.newFaultyTransport clock schedule (livenessSpecMakeResponse spec) (Set.fromList Channels.channelNames))
        (Transport.dispose . Faulty.carrier) $ \transport -> livenessSpecSetup spec transport $ \scenario ->
          bracket (traverse async (livenessScenarioOutputs scenario ++ livenessScenarioSettlements scenario)) (mapM_ cancel) $ \waiting -> do
            now <- retryNow clock
            retryWaitUntil clock (now+bound*1000000)
            done <- traverse (fmap isJust . poll) waiting
            let (notified,settled)=splitAt (length (livenessScenarioOutputs scenario)) done
            unless (and settled) (ioError (userError "L2: an awaited path did not settle"))
            entries <- Faulty.requestLog transport
            let counts=Map.fromListWith (+) [(requestLogEntryRetryKey entry,1::Integer)|entry<-entries]
                lastFaulted=Map.fromList [(requestLogEntryRetryKey entry,requestLogEntryAction entry `elem` [DropReply,RejectEmit])|entry<-entries]
            forM_ (Map.toList counts) $ \(key,count) -> do
              when (count>1+livenessSpecRetryBudget spec) (ioError (userError ("L2: request exceeded retry budget: " ++ Text.unpack key)))
              when (Map.lookup key lastFaulted==Just True && count<=livenessSpecRetryBudget spec && not (null notified) && not (or notified))
                (ioError (userError ("L2: a faulted request was neither retried nor surfaced: " ++ Text.unpack key)))
            unless (and notified) (ioError (userError "L1: an output remained silently pending"))
  unless (QC.isSuccess result) (ioError (userError (QC.output result)))

assertExactlyOnceDelivery :: QC.Args -> QC.Gen [DeliveryOp] -> ((DeliverySubject -> IO ()) -> IO ()) -> IO ()
assertExactlyOnceDelivery args operations setup=do
  result <- QC.quickCheckWithResult args $ QC.forAll operations $ \ops -> QC.ioProperty $ do
    unless (Write `elem` ops) (ioError (userError "an L3 interleaving must write at least one event"))
    setup $ \subject -> do
      let named=zip [0::Integer ..] ops
          written=["e"<>Text.pack (show index)|(index,Write)<-named]
      forM_ named $ \(index,operation) -> case operation of
        Write->write subject ("e"<>Text.pack (show index))
        Transition->transition subject
      actual <- delivered subject
      forM_ written $ \identity -> unless (length (filter (==identity) actual)==1)
        (ioError (userError ("L3: event was not delivered exactly once: " ++ Text.unpack identity)))
  unless (QC.isSuccess result) (ioError (userError (QC.output result)))
