{-# LANGUAGE OverloadedStrings #-}
module ClientAssertionCases (clientAssertionCases) where

import Control.Monad (forM_, unless)
import Crypto.Hash (Digest, SHA256, hash)
import Crypto.Number.Serialize (os2ip)
import Crypto.PubKey.RSA.Types (PublicKey(..), private_pub)
import qualified Crypto.PubKey.RSA.PKCS15 as RSA
import Data.Aeson (FromJSON, Value(..), eitherDecodeStrict', fromJSON, Result(..))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Base64.URL as Base64
import Data.Foldable (toList)
import Data.List (sort)
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8)
import qualified Semiont.ClientAssertion as Assertion
import System.FilePath ((</>))

require :: String -> Bool -> IO ()
require label good = unless good (ioError (userError label))
member :: Text -> Value -> Value
member name (Object fields) = maybe (error "missing client assertion case member") Prelude.id (KM.lookup (Key.fromText name) fields)
member _ _ = error "client assertion case is not an object"
array :: Value -> [Value]
array (Array rows) = toList rows
array _ = error "client assertion cases are not an array"
decode :: FromJSON value => Value -> IO value
decode value = case fromJSON value of Error message -> ioError (userError message); Success parsed -> pure parsed
unbase64 :: Text -> IO Bytes.ByteString
unbase64 = either (ioError . userError) pure . Base64.decodeUnpadded . encodeUtf8
public :: Value -> IO PublicKey
public jwk = do
  modulus <- decode (member "n" jwk) >>= unbase64
  publicExponent <- decode (member "e" jwk) >>= unbase64
  require "shared key is not RSA" (member "kty" jwk==String "RSA")
  pure (PublicKey (Bytes.length modulus) (os2ip modulus) (os2ip publicExponent))

clientAssertionCases :: FilePath -> IO ()
clientAssertionCases root = do
  table <- Bytes.readFile (root </> "protocol/specs/src/session/client-assertion-cases.json")
    >>= either (ioError . userError) pure . eitherDecodeStrict'
  let thumbprints=array (member "thumbprints" table)
      cases=array (member "cases" table)
  require "client assertion authority has no cases" (not (null thumbprints) && not (null cases))
  forM_ thumbprints $ \row -> do
    key <- public (member "jwk" row)
    expected <- decode (member "thumbprint" row)
    require "RSA thumbprint differs from RFC 7638" (Assertion.thumbprint key==expected)
  pem <- Bytes.readFile (root </> "packages/haskell/sdk/test/fixtures/client-assertion-test-only.pem")
  private <- either (ioError . userError . Text.unpack) pure (Assertion.privateKeyFromPem pem)
  nonRsa <- Bytes.readFile (root </> "packages/haskell/sdk/test/fixtures/non-rsa-test-only.pem")
  forM_ [Bytes.empty,"not a key",nonRsa,pem<>pem,"unexpected prefix"<>pem,pem<>"unexpected suffix"] $ \bad ->
    require "PKCS#8 reader accepted an invalid or non-RSA document" (case Assertion.privateKeyFromPem bad of Left message -> not (Text.null message); Right _ -> False)
  forM_ cases $ \row -> do
    key <- public (member "jwk" row)
    require "client assertion header differs from authority" (Assertion.assertionHeader key==member "header" row)
    identity <- decode (member "clientId" row)
    endpoint <- decode (member "tokenEndpoint" row)
    issued <- decode (member "issuedAt" row)
    nonce <- decode (member "jti" row)
    require "client assertion claims differ from authority"
      (Assertion.assertionClaims identity endpoint issued nonce==member "claims" row)
    form <- Assertion.assertionForm private identity endpoint issued nonce
    expectedFields <- mapM decode (array (member "form" table))
    require "assertion grant sends undeclared or missing fields" (sort (map fst form)==sort expectedFields)
    expectedGrant <- decode (member "grantType" table)
    expectedType <- decode (member "assertionType" table)
    require "assertion grant changed its OAuth type" (lookup "grant_type" form==Just expectedGrant && lookup "client_assertion_type" form==Just expectedType)
    compact <- maybe (ioError (userError "assertion form lacks the signed proof")) pure (lookup "client_assertion" form)
    case Text.splitOn "." compact of
      [header,claims,signature] -> do
        headerValue <- unbase64 header >>= either (ioError . userError) pure . eitherDecodeStrict'
        claimValue <- unbase64 claims >>= either (ioError . userError) pure . eitherDecodeStrict'
        bytes <- unbase64 signature
        let input=encodeUtf8 (header<>"."<>claims)
        require "signed JWT header does not name its actual key" (headerValue==Assertion.assertionHeader (private_pub private))
        require "signed JWT changed the account's claims" (claimValue==member "claims" row)
        require "actual RS256 signature did not verify" (RSA.verifyDigest (private_pub private) (hash input :: Digest SHA256) bytes)
        require "modified assertion verified" (not (RSA.verifyDigest (private_pub private) (hash (input<>"x") :: Digest SHA256) bytes))
      _ -> ioError (userError "client assertion is not one compact JWT")
  putStrLn "PASS all shared client-assertion cases, strict PKCS#8 RSA reading and real RS256 signature verification"
