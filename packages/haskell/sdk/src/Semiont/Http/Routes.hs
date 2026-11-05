-- Generated from protocol/specs/src/openapi.json and its paths, and the reference credential classifier. Do not edit.
{-# LANGUAGE GADTs, OverloadedStrings #-}
module Semiont.Http.Routes (HttpRoute(..), routeMethod, routePath, routeStatus, routeMediaType, routeAuthenticated, routeRequestMediaType, routeRequiredHeaders, wireRefusesCredential, persistedScopePrefix, busEventName) where
import Data.ByteString (ByteString)
import Data.Text (Text)
import Data.Aeson (Value(..))
import qualified Data.Aeson.KeyMap as KM
import Semiont.Types
data HttpRoute request answer where
  GetHealthAtRoot :: HttpRoute () HealthResponse
  GetProtectedResourceMetadata :: HttpRoute () ProtectedResourceMetadata
  GetHealth :: HttpRoute () HealthResponse
  GetOpenApiDocument :: HttpRoute () GetOpenApiDocumentResponse
  GetResourceRepresentationWithMediaToken :: HttpRoute () ByteString
  GetStatus :: HttpRoute () StatusResponse
  CreateMediaToken :: HttpRoute MediaTokenRequest MediaTokenResponse
  GetCurrentUser :: HttpRoute () UserResponse
  EmitOnBus :: HttpRoute BusEmitRequest BusEmitAccepted
  SubscribeToBus :: HttpRoute BusSubscribeRequest BusStreamMessage
  UploadResource :: HttpRoute ResourceUpload CreateResourceResponse
  GetResourceRepresentation :: HttpRoute () ByteString
  GetResourceAnchoredText :: HttpRoute () AnchoredTextAnswer
  GetResourceAnnotations :: HttpRoute () GetAnnotationsResponse
  GetResourceJsonLd :: HttpRoute () GetResourceResponse
routeMethod :: HttpRoute request answer -> ByteString
routeMethod GetHealthAtRoot = "GET"
routeMethod GetProtectedResourceMetadata = "GET"
routeMethod GetHealth = "GET"
routeMethod GetOpenApiDocument = "GET"
routeMethod GetResourceRepresentationWithMediaToken = "GET"
routeMethod GetStatus = "GET"
routeMethod CreateMediaToken = "POST"
routeMethod GetCurrentUser = "GET"
routeMethod EmitOnBus = "POST"
routeMethod SubscribeToBus = "POST"
routeMethod UploadResource = "POST"
routeMethod GetResourceRepresentation = "GET"
routeMethod GetResourceAnchoredText = "GET"
routeMethod GetResourceAnnotations = "GET"
routeMethod GetResourceJsonLd = "GET"
routePath :: HttpRoute request answer -> Text
routePath GetHealthAtRoot = "/"
routePath GetProtectedResourceMetadata = "/.well-known/oauth-protected-resource"
routePath GetHealth = "/api/health"
routePath GetOpenApiDocument = "/api/openapi.json"
routePath GetResourceRepresentationWithMediaToken = "/api/resources/{id}"
routePath GetStatus = "/api/status"
routePath CreateMediaToken = "/api/tokens/media"
routePath GetCurrentUser = "/api/users/me"
routePath EmitOnBus = "/bus/emit"
routePath SubscribeToBus = "/bus/subscribe"
routePath UploadResource = "/resources"
routePath GetResourceRepresentation = "/resources/{id}"
routePath GetResourceAnchoredText = "/resources/{id}/anchored-text"
routePath GetResourceAnnotations = "/resources/{id}/annotations"
routePath GetResourceJsonLd = "/resources/{id}/jsonld"
routeStatus :: HttpRoute request answer -> Int
routeStatus GetHealthAtRoot = 200
routeStatus GetProtectedResourceMetadata = 200
routeStatus GetHealth = 200
routeStatus GetOpenApiDocument = 200
routeStatus GetResourceRepresentationWithMediaToken = 200
routeStatus GetStatus = 200
routeStatus CreateMediaToken = 200
routeStatus GetCurrentUser = 200
routeStatus EmitOnBus = 202
routeStatus SubscribeToBus = 200
routeStatus UploadResource = 202
routeStatus GetResourceRepresentation = 200
routeStatus GetResourceAnchoredText = 200
routeStatus GetResourceAnnotations = 200
routeStatus GetResourceJsonLd = 200
routeMediaType :: HttpRoute request answer -> ByteString
routeMediaType GetHealthAtRoot = "application/json"
routeMediaType GetProtectedResourceMetadata = "application/json"
routeMediaType GetHealth = "application/json"
routeMediaType GetOpenApiDocument = "application/json"
routeMediaType GetResourceRepresentationWithMediaToken = "*/*"
routeMediaType GetStatus = "application/json"
routeMediaType CreateMediaToken = "application/json"
routeMediaType GetCurrentUser = "application/json"
routeMediaType EmitOnBus = "application/json"
routeMediaType SubscribeToBus = "text/event-stream"
routeMediaType UploadResource = "application/json"
routeMediaType GetResourceRepresentation = "*/*"
routeMediaType GetResourceAnchoredText = "application/json"
routeMediaType GetResourceAnnotations = "application/json"
routeMediaType GetResourceJsonLd = "application/ld+json"
routeRequestMediaType :: HttpRoute request answer -> Maybe ByteString
routeRequestMediaType GetHealthAtRoot = Nothing
routeRequestMediaType GetProtectedResourceMetadata = Nothing
routeRequestMediaType GetHealth = Nothing
routeRequestMediaType GetOpenApiDocument = Nothing
routeRequestMediaType GetResourceRepresentationWithMediaToken = Nothing
routeRequestMediaType GetStatus = Nothing
routeRequestMediaType CreateMediaToken = Just "application/json"
routeRequestMediaType GetCurrentUser = Nothing
routeRequestMediaType EmitOnBus = Just "application/json"
routeRequestMediaType SubscribeToBus = Just "application/json"
routeRequestMediaType UploadResource = Just "multipart/form-data"
routeRequestMediaType GetResourceRepresentation = Nothing
routeRequestMediaType GetResourceAnchoredText = Nothing
routeRequestMediaType GetResourceAnnotations = Nothing
routeRequestMediaType GetResourceJsonLd = Nothing
routeAuthenticated :: HttpRoute request answer -> Bool
routeAuthenticated GetHealthAtRoot = False
routeAuthenticated GetProtectedResourceMetadata = False
routeAuthenticated GetHealth = False
routeAuthenticated GetOpenApiDocument = False
routeAuthenticated GetResourceRepresentationWithMediaToken = True
routeAuthenticated GetStatus = True
routeAuthenticated CreateMediaToken = True
routeAuthenticated GetCurrentUser = True
routeAuthenticated EmitOnBus = True
routeAuthenticated SubscribeToBus = True
routeAuthenticated UploadResource = True
routeAuthenticated GetResourceRepresentation = True
routeAuthenticated GetResourceAnchoredText = True
routeAuthenticated GetResourceAnnotations = True
routeAuthenticated GetResourceJsonLd = True
routeRequiredHeaders :: HttpRoute request answer -> [(ByteString, Text)]
routeRequiredHeaders GetHealthAtRoot = []
routeRequiredHeaders GetProtectedResourceMetadata = []
routeRequiredHeaders GetHealth = []
routeRequiredHeaders GetOpenApiDocument = []
routeRequiredHeaders GetResourceRepresentationWithMediaToken = []
routeRequiredHeaders GetStatus = []
routeRequiredHeaders CreateMediaToken = []
routeRequiredHeaders GetCurrentUser = []
routeRequiredHeaders EmitOnBus = [("Idempotency-Key", "EmitOnBusHeader0")]
routeRequiredHeaders SubscribeToBus = []
routeRequiredHeaders UploadResource = [("Idempotency-Key", "UploadResourceHeader0")]
routeRequiredHeaders GetResourceRepresentation = []
routeRequiredHeaders GetResourceAnchoredText = []
routeRequiredHeaders GetResourceAnnotations = []
routeRequiredHeaders GetResourceJsonLd = []
wireRefusesCredential :: Int -> Maybe Value -> Bool
wireRefusesCredential status body = status == 401 || (status == 429 && maybe False matches body)
  where matches (Object fields) = KM.lookup "code" fields == Just (String "refusal-rate")
        matches _ = False
persistedScopePrefix :: ResourceId -> Text
persistedScopePrefix scope = "p-" <> resourceIdValue scope <> "-"
busEventName :: Text
busEventName = "bus-event"
