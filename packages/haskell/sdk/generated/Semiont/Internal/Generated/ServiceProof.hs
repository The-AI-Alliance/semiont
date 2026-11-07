-- Generated from core/src/service-account.ts's secret proof; do not edit.
{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Generated.ServiceProof (secretProof) where
import Data.Text (Text)
import qualified Semiont.Internal.Generated.ClientAssertion as Policy
secretProof :: Text -> Text -> [(Text,Text)]
secretProof identity secret = [("grant_type",Policy.grantType),("client_id",identity),("client_secret",secret)]
