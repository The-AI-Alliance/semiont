{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
module Semiont.Internal.Browse
  ( BrowseNamespace, newBrowse, controls, dispose
  , resource, resources, annotations, annotation, entityTypes, tagSchemas, engines, events
  , resourceContent, resourceGraph, resourceAnchoredText, resourceRepresentation, resourceRepresentationStream
  , resourceEvents, annotationHistory, files, kb, click, openResource, resourceViewed
  ) where

import Control.Concurrent.Async (mapConcurrently_)
import Control.Concurrent.STM
import Control.Exception (SomeException, SomeAsyncException, catch, fromException, throwIO)
import Control.Monad (void)
import qualified Semiont.Internal.Lifetime as Lifetime
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (TransportError(..))
import Data.Aeson (ToJSON(..))
import Data.ByteString (ByteString)
import Data.List (find)
import Data.Maybe (fromMaybe)
import Data.Text (Text)
import qualified Semiont.Bus as Bus
import Semiont.Channels
import qualified Semiont.Content as Content
import qualified Semiont.Internal.Cache as Cache
import qualified Semiont.Internal.Generated.CacheRefresh as Fact
import qualified Semiont.Internal.Local as Local
import Semiont.Internal.Queries (cacheOptions)
import qualified Semiont.Internal.Refresh as Refresh
import qualified Semiont.Internal.Transport as LocalBus
import qualified Semiont.Resources as Resources
import qualified Semiont.Timing.Settings as Timing
import qualified Semiont.Transport as Transport
import Semiont.Types
import Streaming (Of, Stream)

data AnnotationKey = AnnotationKey ResourceId AnnotationId
instance ToJSON AnnotationKey where toJSON (AnnotationKey _ identity) = toJSON identity

data BrowseNamespace = BrowseNamespace
  { signalLifetime :: Lifetime.Lifetime, carrier :: Transport.Transport
  , wire :: Bus.Bus, local :: LocalBus.EventBus, content :: Content.ContentTransport, timing :: Timing.Settings
  , resourceCache :: Cache.Cache ResourceId ResourceDescriptor
  , resourcesCache :: Cache.Cache BrowseResourcesRequest ListResourcesResponse
  , annotationsCache :: Cache.Cache ResourceId GetAnnotationsResponse
  , annotationCache :: Cache.Cache AnnotationKey Annotation
  , entityTypesCache :: Cache.Cache () [Text]
  , tagSchemasCache :: Cache.Cache () [TagSchema]
  , enginesCache :: Cache.Cache () [EngineEntry]
  , limitsCache :: Cache.Cache Text [EngineLimits]
  , eventsCache :: Cache.Cache ResourceId [AttributedEvent]
  }

newBrowse :: Bus.Bus -> LocalBus.EventBus -> Transport.Transport -> Content.ContentTransport -> Bus.BusOptions -> Timing.Settings -> IO BrowseNamespace
newBrowse bus signals carrier contents clock settings = do
  let ask operation input = Bus.request bus operation input (Timing.busRequestTimeoutMs settings)
      unscoped = cacheOptions clock settings (const (pure (pure ())))
      scoped = cacheOptions clock settings (Transport.subscribeToResource carrier)
  descriptors <- Cache.newCache
    (\identity -> browseResourceResultResponseResource . browseResourceResultResponse <$> ask BrowseResourceRequestedOperation (BrowseResourceRequest identity mempty)) scoped
  pages <- Cache.newCache (fmap browseResourcesResultResponse . ask BrowseResourcesRequestedOperation) unscoped
  lists <- Cache.newCache (Content.getAnnotations contents) scoped
  details <- Cache.newCache
    (\(AnnotationKey identity mark) -> getAnnotationResponseAnnotation . browseAnnotationResultResponse <$> ask BrowseAnnotationRequestedOperation (BrowseAnnotationRequest mark identity mempty))
    (cacheOptions clock settings (\(AnnotationKey identity _) -> Transport.subscribeToResource carrier identity))
  vocabulary <- Cache.newCache (\() -> getEntityTypesResponseEntityTypes . browseEntityTypesResultResponse <$> ask BrowseEntityTypesRequestedOperation (BrowseEntityTypesRequest mempty)) unscoped
  schemas <- Cache.newCache (\() -> getTagSchemasResponseTagSchemas . browseTagSchemasResultResponse <$> ask BrowseTagSchemasRequestedOperation (BrowseTagSchemasRequest mempty)) unscoped
  models <- Cache.newCache (\() -> browseEnginesResultResponseEngines . browseEnginesResultResponse <$> ask BrowseEnginesRequestedOperation (BrowseEnginesRequest mempty)) unscoped
  limits <- Cache.newCache (\name -> do
    atomically $ do
      ready <- Cache.current (Cache.query models ())
      case ready of Cache.Pending -> retry; Cache.Failed problem -> throwSTM problem; Cache.Ready _ -> pure ()
    case find (\operation -> let (request,_,_) = operationChannels operation in channelName request == name) limitsOperations of
      Nothing -> ioError (userError "unknown derived inference-limits operation")
      Just operation ->
        (inferenceLimitsResultResponseLimits . inferenceLimitsResultResponse <$> ask operation (InferenceLimitsRequest mempty))
        `catch` (\(problem::SomeException) -> case fromException problem :: Maybe SomeAsyncException of
          Just _ -> throwIO problem
          Nothing -> pure [])) unscoped
  history <- Cache.newCache
    (\identity -> getEventsResponseEvents . browseEventsResultResponse <$> ask BrowseEventsRequestedOperation (BrowseEventsRequest Nothing identity Nothing Nothing mempty)) scoped
  life <- Lifetime.newLifetime "browse is disposed"
  pure (BrowseNamespace life carrier bus signals contents settings descriptors pages lists details vocabulary schemas models limits history)

resource :: BrowseNamespace -> ResourceId -> Cache.Query ResourceDescriptor
resource namespace = Cache.query (resourceCache namespace)
resources :: BrowseNamespace -> Maybe BrowseResourcesRequest -> Cache.Query ListResourcesResponse
resources namespace options = Cache.query (resourcesCache namespace) selected
  where
    chosen=fromMaybe (BrowseResourcesRequest Nothing Nothing Nothing Nothing mempty) options
    selected=chosen { browseResourcesRequestLimit=Just (fromMaybe 100 (browseResourcesRequestLimit chosen))
      , browseResourcesRequestOffset=Just (fromMaybe 0 (browseResourcesRequestOffset chosen)) }
annotations :: BrowseNamespace -> ResourceId -> Cache.Query [Annotation]
annotations namespace identity = getAnnotationsResponseAnnotations <$> Cache.query (annotationsCache namespace) identity
annotation :: BrowseNamespace -> ResourceId -> AnnotationId -> Cache.Query Annotation
annotation namespace identity mark = Cache.query (annotationCache namespace) (AnnotationKey identity mark)
entityTypes :: BrowseNamespace -> Cache.Query [Text]
entityTypes namespace = Cache.query (entityTypesCache namespace) ()
tagSchemas :: BrowseNamespace -> Cache.Query [TagSchema]
tagSchemas namespace = Cache.query (tagSchemasCache namespace) ()
engines :: BrowseNamespace -> Cache.Query [EngineWithLimits]
engines namespace = case reports of
  [] -> error "the derived inference-limits operation set is empty"
  first:rest -> Cache.liftQuery2 combine joinLimits (Cache.query (enginesCache namespace) ())
    (foldl (Cache.liftQuery2 combineReports (++)) first rest)
  where
    reports = [Cache.query (limitsCache namespace) (channelName request) | operation <- limitsOperations, let (request,_,_) = operationChannels operation]
    combine state limits = case state of
      Cache.Pending -> Cache.Pending
      Cache.Failed problem -> Cache.Failed problem
      Cache.Ready entries -> Cache.Ready (joinLimits entries (fromMaybe [] (Cache.readyValue limits)))
    combineReports left right = Cache.Ready (fromMaybe [] (Cache.readyValue left) ++ fromMaybe [] (Cache.readyValue right))
    joinLimits entries limits = [EngineWithLimits (engineEntryEngine entry) (engineEntryJobs entry)
      (engineLimitsLimits <$> find (\report -> engineLimitsEngine report == engineEntryEngine entry) limits) | entry <- entries]
events :: BrowseNamespace -> ResourceId -> Cache.Query [AttributedEvent]
events namespace = Cache.query (eventsCache namespace)
resourceContent :: BrowseNamespace -> ResourceId -> IO Text
resourceContent namespace identity = do
  binary <- Content.getBinary (content namespace) identity
  Resources.decodeRepresentation (Content.contentBytes binary) (Content.contentType binary)
resourceGraph :: BrowseNamespace -> ResourceId -> IO GetResourceResponse
resourceGraph = Content.getResourceGraph . content
resourceAnchoredText :: BrowseNamespace -> ResourceId -> IO AnchoredTextAnswer
resourceAnchoredText = Content.getAnchoredText . content
resourceRepresentation :: BrowseNamespace -> ResourceId -> IO Content.BinaryContent
resourceRepresentation = Content.getBinary . content
resourceRepresentationStream :: BrowseNamespace -> ResourceId -> (Text -> Stream (Of ByteString) IO () -> IO result) -> IO result
resourceRepresentationStream namespace identity consume = Content.getBinaryStream (content namespace) identity consume
resourceEvents :: BrowseNamespace -> ResourceId -> IO [AttributedEvent]
resourceEvents namespace identity = getEventsResponseEvents . browseEventsResultResponse <$>
  Bus.request (wire namespace) BrowseEventsRequestedOperation (BrowseEventsRequest Nothing identity Nothing Nothing mempty) (Timing.busRequestTimeoutMs (timing namespace))
annotationHistory :: BrowseNamespace -> ResourceId -> AnnotationId -> IO GetAnnotationHistoryResponse
annotationHistory namespace identity mark = browseAnnotationHistoryResultResponse <$>
  Bus.request (wire namespace) BrowseAnnotationHistoryRequestedOperation (BrowseAnnotationHistoryRequest mark identity mempty) (Timing.busRequestTimeoutMs (timing namespace))
files :: BrowseNamespace -> Maybe Text -> Maybe BrowseDirectoryRequestSort -> IO BrowseDirectoryResultResponse
files namespace path sort = browseDirectoryResultResponse <$>
  Bus.request (wire namespace) BrowseDirectoryRequestedOperation
    (BrowseDirectoryRequest (fromMaybe "." path) (Just (fromMaybe BrowseDirectoryRequestSortName sort)) mempty) (Timing.busRequestTimeoutMs (timing namespace))
kb :: BrowseNamespace -> IO KbDescription
kb namespace = browseKbResultResponse <$> Bus.request (wire namespace) BrowseKbRequestedOperation (BrowseKbRequest mempty) (Timing.busRequestTimeoutMs (timing namespace))
click :: BrowseNamespace -> AnnotationId -> STM ()
click namespace identity = Local.signal (local namespace) BrowseClick (BrowseClickEvent identity mempty) NoScope
openResource :: BrowseNamespace -> ResourceId -> STM ()
openResource namespace identity = Local.signal (local namespace) BrowseResourceOpen (BrowseResourceOpenEvent identity mempty) NoScope
resourceViewed :: BrowseNamespace -> ResourceId -> IO ()
resourceViewed namespace identity = void $ Lifetime.start (signalLifetime namespace) $
  void (Bus.emit (wire namespace) BrowseResourceViewed (BrowseResourceViewedEvent identity mempty) NoScope Nothing)
  `catch` (\(problem::SomeException) -> case fromException problem :: Maybe SomeAsyncException of
    Just _ -> throwIO problem
    Nothing -> LocalBus.reportFailure (carrier namespace) (fromMaybe
      (TransportError Code.TransportError "resource-viewed report failed" Nothing Nothing) (fromException problem)))

controls :: BrowseNamespace -> [(Fact.Query,Refresh.Acts)]
controls namespace =
  [ (Fact.Resource,refetch (resourceCache namespace) ofResource)
  , (Fact.Annotations,(refetch (annotationsCache namespace) ofResource)
      { Refresh.write=Just (Refresh.updateTargets (annotationsCache namespace) ofResource patchList) })
  , (Fact.Annotation,(refetch (annotationCache namespace) ofAnnotation)
      { Refresh.write=Just (Refresh.writeTargets (annotationCache namespace) ofAnnotation (\info prior -> case Refresh.subjectWritten info of Just value -> Just value; Nothing -> prior))
      , Refresh.end=Just (Refresh.endTargets (annotationCache namespace) ofAnnotation) })
  , (Fact.Events,refetch (eventsCache namespace) ofResource)
  , (Fact.Resources,refetch (resourcesCache namespace) (\_ _ -> True))
  , (Fact.EntityTypes,refetch (entityTypesCache namespace) (\_ _ -> True))
  , (Fact.TagSchemas,refetch (tagSchemasCache namespace) (\_ _ -> True))
  , (Fact.Engines,Refresh.Acts (\info reach -> do
      entries <- Refresh.cacheTargets (enginesCache namespace) (\_ _ -> True) info reach
      limits <- Refresh.cacheTargets (limitsCache namespace) (\_ _ -> True) info reach
      pure (entries ++ limits)) Nothing Nothing)
  ]
  where
    refetch cache matches = Refresh.Acts (Refresh.cacheTargets cache matches) Nothing Nothing
    ofResource info identity = Refresh.subjectResource info == Just identity
    ofAnnotation info (AnnotationKey identity mark) = case Refresh.subjectAnnotation info of
      Just selected -> mark == selected
      Nothing -> Refresh.subjectResource info == Just identity
    patchList info prior = case Refresh.subjectWritten info of
      Nothing -> prior
      Just written -> let entries=getAnnotationsResponseAnnotations prior
                          found=any ((==annotationId written) . annotationId) entries
                          updated=if found then map (\held -> if annotationId held==annotationId written then written else held) entries else entries++[written]
                      in prior { getAnnotationsResponseAnnotations=updated }

dispose :: BrowseNamespace -> IO ()
dispose namespace = mapConcurrently_ id
  [ Lifetime.close (signalLifetime namespace), Cache.dispose (resourceCache namespace), Cache.dispose (resourcesCache namespace)
  , Cache.dispose (annotationsCache namespace), Cache.dispose (annotationCache namespace)
  , Cache.dispose (entityTypesCache namespace), Cache.dispose (tagSchemasCache namespace)
  , Cache.dispose (enginesCache namespace), Cache.dispose (limitsCache namespace), Cache.dispose (eventsCache namespace) ]
