{-# LANGUAGE OverloadedStrings #-}
module Semiont.Http
  ( HttpTransport, HttpClient, HttpOptions(..), newHttpClient, newHttpTransport
  , transport, content, gateway, dispose
  ) where

import Control.Exception (onException, finally)
import qualified Data.Set as Set
import Semiont.Channels (scopedChannels)
import Semiont.Content (ContentTransport)
import qualified Semiont.Content as Content
import Semiont.Gateway
import qualified Semiont.Internal.Http as Internal
import Semiont.Internal.Http (HttpClient, HttpOptions(..), newHttpClient)
import Semiont.Internal.HttpActor (runActor)
import Semiont.Internal.HttpContent (newContent)
import Semiont.Http.Routes
import qualified Semiont.Transport as Transport
import Semiont.Types

data HttpTransport = HttpTransport Internal.Http ContentTransport GatewayOperations

newHttpTransport :: HttpOptions -> IO HttpTransport
newHttpTransport options = do
  http <- Internal.newHttp options (Set.union (httpGlobalChannels options) (Set.fromList scopedChannels)) runActor
  contents <- newContent http `onException` Transport.dispose (Internal.transport http)
  let empty = ()
      operations = GatewayOperations
        { getCurrentUser = \override -> Internal.json http GetCurrentUser Nothing override empty
        , getMediaToken = \resource -> Internal.json http CreateMediaToken Nothing Nothing (MediaTokenRequest resource mempty)
        , getProtectedResourceMetadata = Internal.json http GetProtectedResourceMetadata Nothing Nothing empty
        , healthCheck = Internal.json http GetHealth Nothing Nothing empty
        , getStatus = Internal.json http GetStatus Nothing Nothing empty
        }
  pure (HttpTransport http contents operations)

transport :: HttpTransport -> Transport.Transport
transport (HttpTransport http _ _) = Internal.transport http
content :: HttpTransport -> ContentTransport
content (HttpTransport _ contents _) = contents
gateway :: HttpTransport -> GatewayOperations
gateway (HttpTransport _ _ operations) = operations
dispose :: HttpTransport -> IO ()
dispose value = Content.dispose (content value) `finally` Transport.dispose (transport value)
