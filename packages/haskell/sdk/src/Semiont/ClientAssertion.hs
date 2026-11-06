{-# LANGUAGE OverloadedStrings #-}
-- | RS256 proofs of a service account, held to the common assertion table.
module Semiont.ClientAssertion (privateKeyFromPem, thumbprint, assertionHeader, assertionClaims, clientAssertion, assertionForm) where

import Control.Exception (throwIO)
import Crypto.Hash (Digest, SHA256, hash)
import Crypto.Number.Serialize (i2osp)
import Crypto.PubKey.RSA.Types (PrivateKey, PublicKey(..), private_pub)
import qualified Crypto.PubKey.RSA.PKCS15 as RSA
import Data.Aeson (Value, object, (.=), encode)
import qualified Data.ByteArray as Memory
import qualified Data.ByteString as Bytes
import qualified Data.ByteString.Char8 as Char8
import Data.Char (isSpace)
import qualified Data.ByteString.Base64.URL as Base64
import qualified Data.ByteString.Lazy as Lazy
import Data.PEM (pemParseBS, pemName, pemHeader)
import Data.Text (Text)
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import Data.X509 (PrivKey(..))
import Data.X509.Memory (readKeyFileFromMemory)
import Semiont.Errors (SignInError(..))
import Semiont.ErrorCodes (SignInCode(SignInExchange))
import qualified Semiont.Internal.Generated.ClientAssertion as Policy

privateKeyFromPem :: Bytes.ByteString -> Either Text PrivateKey
privateKeyFromPem bytes = case pemParseBS bytes of
  Right [pem] | pemName pem=="PRIVATE KEY" && null (pemHeader pem)
    && "-----BEGIN PRIVATE KEY-----" `Bytes.isPrefixOf` trimmed && "-----END PRIVATE KEY-----" `Bytes.isSuffixOf` trimmed -> case readKeyFileFromMemory bytes of
    [PrivKeyRSA key] -> Right key
    _ -> Left "The PKCS#8 document holds no usable RSA private key"
  _ -> Left "The key must be one unencrypted PKCS#8 PEM private key"
  where trimmed=Char8.dropWhile isSpace (Char8.dropWhileEnd isSpace bytes)

base64 :: Bytes.ByteString -> Text
base64 = decodeUtf8 . Base64.encodeUnpadded
thumbprint :: PublicKey -> Text
thumbprint key = base64 (Memory.convert (hash canonical :: Digest SHA256))
  where
    canonical = "{\"e\":\""<>encodeUtf8 (base64 (i2osp (public_e key)))<>"\",\"kty\":\"RSA\",\"n\":\""
      <>encodeUtf8 (base64 (i2osp (public_n key)))<>"\"}"
assertionHeader :: PublicKey -> Value
assertionHeader key = object ["alg" .= ("RS256"::Text),"kid" .= thumbprint key]
assertionClaims :: Text -> Text -> Integer -> Text -> Value
assertionClaims identity endpoint issued nonce = object
  ["iss" .= identity,"sub" .= identity,"aud" .= endpoint,"jti" .= nonce,"iat" .= issued,"exp" .= (issued+Policy.lifetimeSeconds)]

clientAssertion :: PrivateKey -> Text -> Text -> Integer -> Text -> IO Text
clientAssertion key identity endpoint issued nonce = do
  let segment = base64 . Lazy.toStrict . encode
      input = segment (assertionHeader (private_pub key))<>"."<>segment (assertionClaims identity endpoint issued nonce)
  signed <- RSA.signSaferDigest key (hash (encodeUtf8 input) :: Digest SHA256)
  case signed of
    Left _ -> throwIO (SignInError SignInExchange "The account key could not sign RS256" Nothing)
    Right signature -> pure (input<>"."<>base64 signature)

assertionForm :: PrivateKey -> Text -> Text -> Integer -> Text -> IO [(Text,Text)]
assertionForm key identity endpoint issued nonce = do
  proof <- clientAssertion key identity endpoint issued nonce
  pure [("grant_type",Policy.grantType),("client_assertion_type",Policy.assertionType),("client_assertion",proof)]
