module Semiont.Internal.Gather (GatherNamespace, newGather, annotation, resource, referencedBy, controls, dispose) where

import Data.Maybe (fromMaybe)
import qualified Semiont.Bus as Bus
import Semiont.Channels
import qualified Semiont.Internal.Cache as Cache
import qualified Semiont.Internal.Generated.CacheRefresh as Fact
import Semiont.Internal.Queries (cacheOptions, oneReport)
import qualified Semiont.Internal.Refresh as Refresh
import qualified Semiont.Internal.Running as Running
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Types

data GatherNamespace = GatherNamespace Bus.Bus Timing.Settings (Cache.Cache ResourceId Fact.ReferencedByValue)
newGather :: Bus.Bus -> Transport.Transport -> Bus.BusOptions -> Timing.Settings -> IO GatherNamespace
newGather wire carrier clock timing = GatherNamespace wire timing <$> Cache.newCache
  (\identity -> getReferencedByResponseReferencedBy . gatherReferencedByResultResponse <$>
    Bus.request wire GatherReferencedByRequestedOperation (GatherReferencedByRequest Nothing identity mempty) (Timing.busRequestTimeoutMs timing))
  (cacheOptions clock timing (Transport.subscribeToResource carrier))
annotation :: GatherNamespace -> ResourceId -> AnnotationId -> Maybe GatherAnnotationOptions -> IO (Running.Running GatherAnnotationComplete GatherAnnotationComplete)
annotation (GatherNamespace wire timing _) identity mark options = oneReport $
  Bus.request wire GatherRequestedOperation (GatherAnnotationRequest mark (Just withWindow) identity mempty) (Timing.busRequestTimeoutMs timing)
  where
    chosen = fromMaybe (GatherAnnotationOptions Nothing Nothing Nothing mempty) options
    withWindow = chosen { gatherAnnotationOptionsContextWindow = Just (fromMaybe 2000 (gatherAnnotationOptionsContextWindow chosen)) }
resource :: GatherNamespace -> ResourceId -> Maybe GatherResourceOptions -> IO GatheredContext
resource (GatherNamespace wire timing _) identity options = gatherResourceCompleteResponse <$>
  Bus.request wire GatherResourceRequestedOperation (GatherResourceRequest selected identity mempty) (Timing.busRequestTimeoutMs timing)
  where
    chosen = fromMaybe (GatherResourceOptions Nothing Nothing Nothing Nothing Nothing mempty) options
    selected = GatherResourceRequestOptions
      (fromMaybe 2 (gatherResourceOptionsDepth chosen))
      (case gatherResourceOptionsExcludeEntityTypes chosen of Just [] -> Nothing; other -> other)
      (fromMaybe True (gatherResourceOptionsIncludeContent chosen))
      (fromMaybe False (gatherResourceOptionsIncludeSummary chosen))
      (fromMaybe 10 (gatherResourceOptionsMaxResources chosen))
      (gatherResourceOptionsAdditionalProperties chosen)
referencedBy :: GatherNamespace -> ResourceId -> Cache.Query [GetReferencedByResponseReferencedByItem]
referencedBy (GatherNamespace _ _ cache) = Cache.query cache
controls :: GatherNamespace -> [(Fact.Query,Refresh.Acts)]
controls (GatherNamespace _ _ cache) = [(Fact.ReferencedBy,Refresh.Acts
  (Refresh.cacheTargets cache (\info identity -> Refresh.subjectResource info == Just identity)) Nothing Nothing)]
dispose :: GatherNamespace -> IO ()
dispose (GatherNamespace _ _ cache) = Cache.dispose cache
