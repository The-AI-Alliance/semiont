{-# LANGUAGE OverloadedStrings #-}
-- | Run correlated matching requests on the client's signal plane.
module Semiont.State.Match (MatchStateUnit, newMatchStateUnit, dispose) where

import Control.Concurrent.STM (atomically)
import Control.Exception (catches, Handler(..))
import Data.Aeson (Value(..))
import Data.Text (Text)
import qualified Semiont.Client as Client
import Semiont.Channels
import Semiont.Errors (BusRequestError(..), TransportError(..))
import qualified Semiont.Internal.Local as Local
import qualified Semiont.Internal.StateTasks as Tasks
import qualified Semiont.Internal.Transport as Transport
import qualified Semiont.Match as Match
import qualified Semiont.Running as Running
import Semiont.Types hiding (MatchSearchFailed)
import qualified Semiont.Types as Types

newtype MatchStateUnit = MatchStateUnit Tasks.Tasks
newMatchStateUnit :: Client.Client -> IO MatchStateUnit
newMatchStateUnit client = do
  tasks <- Tasks.newTasks "match state unit is closed"
  Tasks.listen tasks (Client.bus client) [channelName MatchSearchRequested] $ \frame -> do
    let envelope=Transport.wireFrame frame
    case decodePayload MatchSearchRequested (Object (busFramePayloadAdditionalProperties (busFramePayload envelope))) of
      Left _ -> pure ()
      Right input -> Tasks.fork tasks $ do
        let reply :: Text -> IO ()
            reply message=atomically (Local.signalWithCorrelation (Client.bus client) MatchSearchFailed
              (Types.MatchSearchFailed Nothing Nothing message (matchSearchRequestReferenceId input) mempty) NoScope (busFrameCorrelationId envelope))
            work=do
              found <- Match.search (Client.match client) (matchSearchRequestResourceId input) (matchSearchRequestReferenceId input)
                (matchSearchRequestContext input) (Just (MatchSearchOptions (matchSearchRequestLimit input) (matchSearchRequestUseSemanticScoring input) (matchSearchRequestAdditionalProperties input))) >>= Running.await
              atomically (Local.signalWithCorrelation (Client.bus client) MatchSearchResults found NoScope (busFrameCorrelationId envelope))
        work `catches` [Handler (reply . busRequestErrorMessage),Handler (reply . transportErrorMessage)]
  pure (MatchStateUnit tasks)
dispose :: MatchStateUnit -> IO ()
dispose (MatchStateUnit tasks) = Tasks.dispose tasks
