{-# LANGUAGE OverloadedStrings #-}

module Discovery (discoveryCases) where

import Control.Concurrent.Async (async, wait)
import Control.Concurrent.STM
import Control.Exception (AsyncException(UserInterrupt), throwIO, try)
import Control.Monad (unless)
import Data.Aeson (Value(..), encode, toJSON)
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Lazy as Lazy
import Data.Text.Encoding (decodeUtf8, decodeUtf8')
import qualified Semiont.Discovery as D
import qualified Semiont.Timing as Timing
import Semiont.Types (DiscoveryDocument(..), DiscoveredKB(..))
import qualified Streaming.Prelude as Stream
import System.IO.Error (doesNotExistErrorType, mkIOError)
import System.Timeout (timeout)

require :: String -> Bool -> IO ()
require label value = unless value (ioError (userError label))

discoveryCases :: DiscoveredKB -> DiscoveryDocument -> IO ()
discoveryCases sample sampleDocument = do
  result <- timeout 5000000 (cases sample sampleDocument)
  require "discovery liveness deadline expired" (result == Just ())
  putStrLn "PASS whole-document discovery, duplicate-aware diffs and controlled polling"

cases :: DiscoveredKB -> DiscoveryDocument -> IO ()
cases sample sampleDocument = do
  let kb = sample { discoveredKBHost = "localhost", discoveredKBPort = 8800, discoveredKBDid = "did:web:example.org" }
      other = kb { discoveredKBPort = 8801 }
      changed = kb { discoveredKBSiteName = Just "New name" }
      document entries = sampleDocument { discoveryDocumentKbs = entries }
      render value = decodeUtf8 (Lazy.toStrict (encode value))
      parsed entries = D.parseDiscoveryDocument (render (document entries))
      reason expected value = case value of D.Absent actual _ -> actual == expected; D.Managed _ -> False
  require "empty managed document was treated as absent" (parsed [] == D.Managed [])
  require "valid discovery entries were not retained" (parsed [kb, other] == D.Managed [kb, other])
  require "malformed JSON was not classified" (reason D.DiscoveryAbsentNotJson (D.parseDiscoveryDocument "{"))
  require "non-object document was not refused" (reason D.DiscoveryAbsentInvalid (D.parseDiscoveryDocument "[]"))
  require "one invalid entry did not refuse the entire document"
    (reason D.DiscoveryAbsentInvalid (parsed [kb, other { discoveredKBPort = 65536 }]))
  let replace key value = case toJSON (document [kb]) of Object fields -> Object (KM.insert key value fields); _ -> error "generated document is not an object"
  require "unsupported version was read in part" (reason D.DiscoveryAbsentUnsupportedVersion (D.parseDiscoveryDocument (render (replace "version" (Number 2)))))
  require "fractional version was not invalid" (reason D.DiscoveryAbsentInvalid (D.parseDiscoveryDocument (render (replace "version" (Number 1.5)))))
  let initial = D.discoveryDiff Nothing (D.Managed [kb])
  require "initial discovery did not report every entry" (fmap D.added initial == Just [kb])
  require "a shared DID merged two addresses" (fmap D.added (D.discoveryDiff (Just (D.Managed [kb])) (D.Managed [kb, other])) == Just [other])
  require "document reorder emitted a change" (D.discoveryDiff (Just (D.Managed [kb, other])) (D.Managed [other, kb]) == Nothing)
  require "metadata update was not reported" (fmap D.updated (D.discoveryDiff (Just (D.Managed [kb])) (D.Managed [changed])) == Just [changed])
  let duplicate = D.discoveryDiff (Just (D.Managed [kb])) (D.Managed [kb, kb])
  require "an identical duplicate claim was hidden" (fmap D.duplicated duplicate == Just ["localhost:8800"])
  require "an unchanged ambiguous address emitted repeated updates"
    (D.discoveryDiff (Just (D.Managed [kb, changed])) (D.Managed [changed, kb]) == Nothing)
  let absent = D.Absent D.DiscoveryAbsentNotFound Nothing
  require "an absent launcher did not remove its managed entries"
    (fmap D.removed (D.discoveryDiff (Just (D.Managed [kb, other])) absent) == Just [kb, other])
  require "a diagnostic-only change emitted a state change"
    (D.discoveryDiff (Just absent) (D.Absent D.DiscoveryAbsentNotFound (Just "new diagnostic")) == Nothing)
  missing <- D.readDiscovery (D.textDiscovery (ioError (mkIOError doesNotExistErrorType "missing" Nothing Nothing)))
  require "missing file was not classified" $ case missing of D.Read value -> reason D.DiscoveryAbsentNotFound value; _ -> False
  unreadable <- D.readDiscovery (D.textDiscovery (ioError (userError "unreadable")))
  require "read failure was not classified" $ case unreadable of D.Read value -> reason D.DiscoveryAbsentUnreadable value; _ -> False
  badUtf8 <- D.readDiscovery (D.textDiscovery (either throwIO pure (decodeUtf8' (Bytes.singleton 255))))
  require "malformed UTF-8 was not classified" $ case badUtf8 of D.Read value -> reason D.DiscoveryAbsentUnreadable value; _ -> False
  cancelled <- try (D.readDiscovery (D.textDiscovery (throwIO UserInterrupt))) :: IO (Either AsyncException D.DiscoveryRead)
  require "discovery swallowed cancellation" (cancelled == Left UserInterrupt)
  clock <- newTVarIO 0
  waits <- newTQueueIO
  observations <- newTVarIO [D.Read (D.Managed [kb]), D.Unchanged, D.Read (D.Managed [changed])]
  readCount <- newTVarIO (0 :: Int)
  let transport = D.DiscoveryTransport $ atomically $ do
        remaining <- readTVar observations
        case remaining of
          [] -> throwSTM (userError "discovery polled after its reader stopped")
          value : rest -> modifyTVar' readCount (+ 1) >> writeTVar observations rest >> pure value
      options = D.DiscoveryOptions
        { D.discoveryNow = readTVarIO clock
        , D.discoveryWaitUntil = \deadline -> do
            atomically (writeTQueue waits deadline)
            atomically (readTVar clock >>= check . (>= deadline))
        , D.discoveryIntervalMs = Timing.discoveryIntervalMs
        }
      duration = Timing.discoveryIntervalMs * 1000000
  worker <- async (Stream.toList_ (Stream.take 2 (D.subscribeDiscovery options transport)))
  first <- atomically (readTQueue waits)
  require "discovery ignored its caller-controlled interval" (first == duration)
  atomically (writeTVar clock (first - 1))
  before <- readTVarIO readCount
  require "discovery polled before the interval" (before == 1)
  atomically (writeTVar clock first)
  second <- atomically (readTQueue waits)
  afterUnchanged <- readTVarIO readCount
  require "unchanged response lost the polling cadence" (second == 2 * duration && afterUnchanged == 2)
  atomically (writeTVar clock second)
  notices <- wait worker
  require "discovery lost its initial or changed notice" (map D.state notices == [D.Managed [kb], D.Managed [changed]])
  remainingWait <- atomically (tryReadTQueue waits)
  require "discovery retained polling work after consumption ended" (remainingWait == Nothing)
