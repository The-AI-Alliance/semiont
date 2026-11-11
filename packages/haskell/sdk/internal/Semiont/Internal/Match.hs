{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Match (MatchNamespace, newMatch, search, requestSearch, resources, controls, dispose) where

import Control.Concurrent.STM (STM)
import Data.Maybe (fromMaybe)
import Data.Text (Text)
import qualified Semiont.Bus as Bus
import Semiont.Channels
import qualified Semiont.Internal.Cache as Cache
import qualified Semiont.Internal.Generated.CacheRefresh as Fact
import qualified Semiont.Internal.Local as Local
import Semiont.Internal.Queries (cacheOptions, oneReport)
import qualified Semiont.Internal.Refresh as Refresh
import qualified Semiont.Internal.Running as Running
import qualified Semiont.Internal.Transport as LocalBus
import qualified Semiont.Timing.Settings as Timing
import Semiont.Types

data MatchNamespace = MatchNamespace Bus.Bus LocalBus.EventBus Timing.Settings (Cache.Cache MatchResourcesRequest Fact.MatchedResourcesValue)
newMatch :: Bus.Bus -> LocalBus.EventBus -> Bus.BusOptions -> Timing.Settings -> IO MatchNamespace
newMatch wire local clock timing = MatchNamespace wire local timing <$> Cache.newCache
  (\input -> matchResourcesResultResponse <$> Bus.request wire MatchResourcesRequestedOperation input (Timing.busRequestTimeoutMs timing))
  (cacheOptions clock timing (const (pure (pure ()))))
search :: MatchNamespace -> ResourceId -> AnnotationId -> GatheredContext -> Maybe MatchSearchOptions -> IO (Running.Running MatchSearchResult MatchSearchResult)
search (MatchNamespace wire _ timing _) identity reference context options = oneReport $
  Bus.request wire MatchSearchRequestedOperation
    (MatchSearchRequest context (Just (fromMaybe 10 (matchSearchOptionsLimit chosen))) reference identity
      (Just (fromMaybe True (matchSearchOptionsUseSemanticScoring chosen))) (matchSearchOptionsAdditionalProperties chosen))
    (Timing.busRequestTimeoutMs timing)
  where chosen = fromMaybe (MatchSearchOptions Nothing Nothing mempty) options
requestSearch :: MatchNamespace -> MatchSearchRequest -> Text -> STM ()
requestSearch (MatchNamespace _ local _ _) input correlation = Local.signalWithCorrelation local MatchSearchRequested input NoScope (Just correlation)
resources :: MatchNamespace -> Text -> Maybe BrowseResourcesRequest -> Cache.Query MatchResourcesResponse
resources (MatchNamespace _ _ _ cache) text filters = Cache.query cache
  (MatchResourcesRequest (browseResourcesRequestArchived selected) (browseResourcesRequestEntityType selected)
    (Just (fromMaybe 100 (browseResourcesRequestLimit selected))) (Just (fromMaybe 0 (browseResourcesRequestOffset selected))) text
    (browseResourcesRequestAdditionalProperties selected))
  where selected = fromMaybe (BrowseResourcesRequest Nothing Nothing Nothing Nothing mempty) filters
controls :: MatchNamespace -> [(Fact.Query,Refresh.Acts)]
controls (MatchNamespace _ _ _ cache) = [(Fact.MatchedResources,Refresh.Acts
  (Refresh.cacheTargets cache (\_ _ -> True)) Nothing Nothing)]
dispose :: MatchNamespace -> IO ()
dispose (MatchNamespace _ _ _ cache) = Cache.dispose cache
