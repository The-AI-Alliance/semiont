{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
-- | One service account's lazy client-credentials grant. No private key or
-- secret is sent to a gateway; only the issuer receives the account's proof.
module Semiont.ServiceToken (ServiceToken, newServiceTokenSecret, newServiceTokenKey, token, renew, authorization, dispose) where

import Control.Concurrent.MVar
import Control.Exception (throwIO, try, SomeException)
import Crypto.PubKey.RSA.Types (PrivateKey)
import Crypto.Random (getRandomBytes)
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Base64.URL as Base64
import Data.Scientific (Scientific)
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (decodeUtf8)
import qualified Semiont.ClientAssertion as Assertion
import Semiont.Errors (SignInError(..))
import qualified Semiont.ErrorCodes as Code
import Semiont.Internal.Generated.ServiceProof (secretProof)
import qualified Semiont.Internal.Issuer as Issuer
import qualified Semiont.Internal.Lifetime as Lifetime
import qualified Semiont.Retry as Retry
import qualified Semiont.Tokens as Tokens

data ServiceToken = ServiceToken Issuer.IssuerOptions Text (Text -> IO [(Text,Text)]) (MVar Held) Lifetime.Lifetime
data Held = Held (Maybe Text) (Maybe (Text,Integer))

newServiceTokenSecret :: Issuer.IssuerOptions -> Text -> Text -> Text -> IO ServiceToken
newServiceTokenSecret options authority identity secret =
  make options authority (\_ -> pure (secretProof identity secret))

newServiceTokenKey :: Issuer.IssuerOptions -> Text -> Text -> PrivateKey -> IO Scientific -> IO ServiceToken
newServiceTokenKey options authority identity key wallNow = make options authority $ \endpoint -> do
  issued <- floor <$> wallNow
  nonce <- decodeUtf8 . Base64.encodeUnpadded <$> (getRandomBytes 24 :: IO Bytes.ByteString)
  Assertion.assertionForm key identity endpoint issued nonce

make :: Issuer.IssuerOptions -> Text -> (Text -> IO [(Text,Text)]) -> IO ServiceToken
make options authority proof = ServiceToken options authority proof <$> newMVar (Held Nothing Nothing)
  <*> Lifetime.newLifetime "Service token is closed"

token :: ServiceToken -> IO Text
token value = acquire value Nothing
renew :: ServiceToken -> Text -> IO Text
renew value refused = acquire value (Just refused)
authorization :: ServiceToken -> IO Text
authorization value = ("Bearer "<>) <$> token value

acquireEndpoint :: Issuer.IssuerOptions -> Text -> Maybe Text -> IO Text
acquireEndpoint _ _ (Just endpoint) = pure endpoint
acquireEndpoint options authority Nothing = Issuer.configuration options authority
  >>= Issuer.requiredText Code.SignInDiscovery "token_endpoint"

acquire :: ServiceToken -> Maybe Text -> IO Text
acquire (ServiceToken options authority proof held lifetime) refused = Lifetime.run lifetime $ do
  answer <- modifyMVar held $ \(Held endpoint cached) -> do
    now <- Retry.retryNow (Issuer.issuerTime options)
    case cached of
      Just (access,due) | now<due && Just access/=refused -> pure (Held endpoint cached,Right access)
      _ -> do
        address <- acquireEndpoint options authority endpoint
        -- The endpoint was learned successfully even if the grant fails. A
        -- token already refused, or due, is never restored as a usable cache.
        granted <- try $ do
          form <- proof address
          Issuer.Answer status body <- Issuer.requestJson options Code.SignInExchange address (Just form)
          unlessGood status (status>=200 && status<300)
          access <- Issuer.requiredText Code.SignInExchange "access_token" body
          unlessGood status (not (Text.null access))
          instant <- Retry.retryNow (Issuer.issuerTime options)
          let reuse = case Issuer.number "expires_in" body of
                Nothing -> Nothing
                Just seconds | seconds<=0 -> Nothing
                Just seconds -> Just (access,instant+ceiling
                  (min seconds (Tokens.renewalDelay (Issuer.issuerTiming options) seconds seconds)*1000000000))
          pure (reuse,access)
        case granted of
          Left (failure :: SomeException) -> pure (Held (Just address) Nothing,Left failure)
          Right (reuse,access) -> pure (Held (Just address) reuse,Right access)
  either throwIO pure answer
  where
    unlessGood status good = if good then pure () else throwIO
      (SignInError Code.SignInExchange "The issuer refused the account grant" (Just status))

dispose :: ServiceToken -> IO ()
dispose (ServiceToken _ _ _ _ lifetime) = Lifetime.close lifetime
