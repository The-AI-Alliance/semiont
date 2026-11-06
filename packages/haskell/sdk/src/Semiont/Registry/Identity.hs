{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
-- | Prove the knowledge base reached by a fresh credential. An address is
-- never an identity, and no DID is manufactured when the KB cannot say it.
module Semiont.Registry.Identity
  ( ConnectionIdentity(..), IdentityUnverifiableError(..), describeConnection, samePlace
  ) where

import Control.Exception (Exception, SomeException, SomeAsyncException, bracket, fromException, throwIO, try)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Text (Text)
import qualified Data.Text as Text
import qualified Semiont.Browse as Browse
import qualified Semiont.Client as Client
import qualified Semiont.Gateway as Gateway
import qualified Semiont.Http as Http
import Semiont.Channels (channelName, operationChannels, Operation(BrowseKbRequestedOperation))
import Semiont.Errors (BusRequestError(..))
import Semiont.ErrorCodes (KbIdentityCode(..), BusRequestCode(BusRequestRejected))
import qualified Semiont.Identity as Identity
import Semiont.Types

data IdentityUnverifiableError = IdentityUnverifiableError
  { identityUnverifiableReason :: KbIdentityCode
  , identityUnverifiableDetail :: Text
  } deriving (Eq, Show)
instance Exception IdentityUnverifiableError

samePlace :: KbEndpoint -> KbEndpoint -> Bool
samePlace (KbEndpointBranch1 one) (KbEndpointBranch1 other)=
  httpEndpointProtocol one==httpEndpointProtocol other && Text.toLower (httpEndpointHost one)==Text.toLower (httpEndpointHost other)
    &&httpEndpointPort one==httpEndpointPort other
samePlace (KbEndpointBranch2 one) (KbEndpointBranch2 other)=localEndpointKbId one==localEndpointKbId other
samePlace _ _=False

describeConnection :: Http.HttpOptions -> HttpEndpoint -> Text -> IO ConnectionIdentity
describeConnection http target access = do
  base <- either (throwIO . IdentityUnverifiableError KbIdentityUnreachable) pure (Gateway.gatewayUrl target)
  let (_,result,failure)=operationChannels BrowseKbRequestedOperation
      options=http { Http.httpBaseUrl=base,Http.httpToken=pure (Just access),Http.httpRenewToken=const (pure Nothing)
        ,Http.httpGlobalChannels=Set.fromList [channelName result,channelName failure]
        ,Http.httpLoadPositions=pure Map.empty,Http.httpSavePosition= \_ _ -> pure () }
  readBack <- try $ bracket (Client.fromHttp options Nothing) Client.dispose (Browse.kb . Client.browse)
  description <- case readBack of
    Right value -> pure value
    Left (problem::SomeException) -> case fromException problem :: Maybe SomeAsyncException of
      Just _ -> throwIO problem
      Nothing -> throwIO (IdentityUnverifiableError (case fromException problem of
        Just refusal | busRequestErrorCode refusal==BusRequestRejected -> KbIdentityNotReported
        _ -> KbIdentityUnreachable) "The knowledge base could not establish its identity with the issued credential")
  did <- either (throwIO . IdentityUnverifiableError KbIdentityNotReported . Text.pack) pure (Identity.kbDid (kbDescriptionDomain description))
  pure (ConnectionIdentity description did mempty)
