{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
-- | Conditional HTTP reads of a launcher's whole discovery document.
module Semiont.Http.Discovery (httpDiscovery) where

import Control.Concurrent.Async (race)
import Control.Concurrent.MVar (newMVar, modifyMVar)
import Control.Exception (try)
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Data.ByteString as Bytes
import Data.Text.Encoding (decodeUtf8', decodeUtf8With)
import Data.Text.Encoding.Error (lenientDecode)
import Network.HTTP.Client
import Network.HTTP.Types (statusCode, hAccept, hContentType, hETag, hIfNoneMatch)
import Network.URI (parseURI, uriAuthority, uriUserInfo, uriScheme, uriFragment)
import Semiont.Discovery
import Semiont.Internal.Http (HttpClient(..))
import qualified Semiont.Retry as Retry
import qualified Semiont.Timing.Settings as Timing

-- | The caller owns its HTTP pool. Reads are serial and bounded by the
-- caller's clock; only a complete managed document replaces the saved ETag.
httpDiscovery :: HttpClient -> Retry.RetryOptions -> Timing.Settings -> Text -> IO DiscoveryTransport
httpDiscovery (HttpClient manager) time timing url = do
  case parseURI (Text.unpack url) of
    Just uri | uriScheme uri `elem` ["http:","https:"] && null (uriFragment uri)
      && maybe False (null . uriUserInfo) (uriAuthority uri) -> pure ()
    _ -> ioError (userError "Discovery needs a credential-free HTTP URL")
  template <- parseRequest (Text.unpack url)
  tag <- newMVar Nothing
  pure $ DiscoveryTransport $ modifyMVar tag $ \previous -> do
    let request = template
          { requestHeaders=[(hAccept,"application/json")] ++ maybe [] (\value -> [(hIfNoneMatch,value)]) previous
          , checkResponse= \_ _ -> pure ()
          , responseTimeout=responseTimeoutNone
          }
        readResponse = withResponse request manager $ \response -> do
          bytes <- Bytes.concat <$> brConsume (responseBody response)
          let code=statusCode (responseStatus response)
              headers=responseHeaders response
              contentType=maybe "" (Text.toLower . decodeUtf8With lenientDecode) (lookup hContentType headers)
              absent reason diagnostic = (previous,Read (Absent reason (Just diagnostic)))
          pure $ if code==304 then (previous,Unchanged)
            else if code<200 || code>=300 then absent DiscoveryAbsentNotFound ("HTTP "<>Text.pack (show code))
            else if not ("json" `Text.isInfixOf` contentType) then absent DiscoveryAbsentNotFound ("The content type is "<>contentType)
            else case decodeUtf8' bytes of
              Left _ -> absent DiscoveryAbsentUnreadable "The discovery document is not UTF-8"
              Right text -> case parseDiscoveryDocument text of
                state@(Managed _) -> (lookup hETag headers,Read state)
                state -> (previous,Read state)
    now <- Retry.retryNow time
    answer <- try (race readResponse (Retry.retryWaitUntil time (now+Timing.httpRequestTimeoutMs timing*1000000)))
    case answer of
      Left (_ :: HttpException) -> pure (previous,Read (Absent DiscoveryAbsentUnreadable (Just "The discovery request received no usable answer")))
      Right (Right ()) -> pure (previous,Read (Absent DiscoveryAbsentUnreadable (Just "The discovery request deadline expired")))
      Right (Left result) -> pure result
