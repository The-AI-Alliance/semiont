{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.StreamFrame (ReadFrame(..), readFrame) where

import Data.Aeson (Value(..), Result(..), eitherDecodeStrict', fromJSON)
import qualified Data.Aeson.KeyMap as KM
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8)
import Semiont.Internal.Required (Fault, faultOf, undecoded)
import Semiont.Types (BusFrame)

data ReadFrame = Accepted BusFrame | Rejected (Maybe Text) Fault deriving (Eq, Show)
readFrame :: Text -> ReadFrame
readFrame text = case eitherDecodeStrict' (encodeUtf8 text) of
  Left _ -> Rejected Nothing undecoded
  Right value ->
    let channel = case value of
          Object fields | Just (String name) <- KM.lookup "channel" fields, not (Text.null name) -> Just name
          _ -> Nothing
    in case faultOf "BusFrame" value of
      Just issue -> Rejected channel issue
      Nothing -> case fromJSON value of
        Error _ -> Rejected channel undecoded
        Success frame -> Accepted frame
