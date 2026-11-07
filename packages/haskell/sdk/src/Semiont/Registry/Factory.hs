{-# LANGUAGE ScopedTypeVariables #-}
-- | Session ownership supplied to a registry, over HTTP or a host's carrier.
module Semiont.Registry.Factory (SessionFactory(..), SessionFactoryOptions(..), newHttpSessionFactory) where

import Control.Concurrent.STM (atomically)
import Control.Exception (catch)
import Semiont.Errors (SignInError)
import Data.Scientific (Scientific)
import qualified Semiont.Client as Client
import qualified Semiont.Auth as Auth
import qualified Semiont.Http as Http
import qualified Semiont.Issuer as Issuer
import qualified Semiont.Session as Session
import qualified Semiont.Registry.Stored as Stored
import qualified Semiont.State.SessionSignals as Signals
import Semiont.Internal.Generated.SessionFactoryOptions
import Semiont.Types

data SessionFactory = SessionFactory
  { openSession :: SessionFactoryOptions -> IO Session.OpenedSession
  , revokeSession :: StoredSession -> IO ()
  }

newHttpSessionFactory :: Http.HttpOptions -> IO Scientific -> SessionFactory
newHttpSessionFactory http wall = SessionFactory open revoke
  where
    issuer=Issuer.IssuerOptions (Http.httpClient http) (Http.httpTime http) (Http.httpTiming http)
    revoke held=(mapM_ (\endpoint -> Issuer.revokeAtIssuer issuer endpoint (storedSessionClientId held) (storedSessionRefresh held))
      (storedSessionRevocationEndpoint held)) `catch` (\(_::SignInError) -> pure ())
    open options = do
      let kb=sessionFactoryOptionsKb options
          kept=Stored.keptIn (sessionFactoryOptionsStorage options) (knowledgeBaseId kb)
          settings=Session.SessionOptions (knowledgeBaseId kb) (KbTarget (knowledgeBaseEndpoint kb) (knowledgeBaseId kb) (knowledgeBaseLabel kb) mempty) kept
            Nothing Nothing (Just validate)
            (atomically . Signals.notifySessionEnded (sessionFactoryOptionsSignals options))
            (sessionFactoryOptionsOnError options) wall
          persistence=Just (Client.CachePersistence (sessionFactoryOptionsStorage options) (knowledgeBaseId kb) ((*1000) <$> wall))
      Session.fromKeptSession http persistence settings
    validate client access=case Client.auth client of
      Nothing -> ioError (userError "The HTTP session factory built no gateway identity operation")
      Just auth -> Just <$> Auth.me auth (Just access)
