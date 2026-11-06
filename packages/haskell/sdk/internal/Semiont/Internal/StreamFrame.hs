{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.StreamFrame (ReadFrame(..), readFrame) where

import Data.Aeson (Value(..), Result(..), eitherDecodeStrict', fromJSON)
import qualified Data.Aeson.KeyMap as KM
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8)
import Semiont.Internal.Required (Fault, faultOf, undecoded)
import Semiont.Internal.Transport (FrameRefusal(..))
import Semiont.Types (BusFrame)

data ReadFrame = Accepted BusFrame | Refused FrameRefusal | Rejected Fault deriving (Eq, Show)
readFrame :: Text -> ReadFrame
readFrame text = case eitherDecodeStrict' (encodeUtf8 text) of
  Left _ -> Rejected undecoded
  Right value -> case faultOf "BusFrame" value of
    Just issue -> refuse value issue
    Nothing -> case fromJSON value of
      Error _ -> refuse value undecoded
      Success frame -> Accepted frame
  where
    nonempty (Just (String value)) | not (Text.null value) = Just value
    nonempty _ = Nothing
    refuse (Object fields) issue
      | Just channel <- nonempty (KM.lookup "channel" fields)
      , Just scope <- readScope (KM.lookup "scope" fields) =
          Refused (FrameRefusal channel (KM.lookup "payload" fields) scope
            (nonempty (KM.lookup "correlationId" fields)) issue)
    refuse _ issue = Rejected issue
    readScope Nothing = Just Nothing
    readScope (Just Null) = Just Nothing
    readScope (Just value) = case fromJSON value of Error _ -> Nothing; Success scope -> Just (Just scope)
