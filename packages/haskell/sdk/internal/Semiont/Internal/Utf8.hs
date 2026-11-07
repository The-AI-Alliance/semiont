-- | The Encoding Standard's replacement grouping and invalid-byte reconsumption.
module Semiont.Internal.Utf8 (decodeUtf8) where

import Data.Bits ((.&.), shiftL)
import qualified Data.ByteString as Bytes
import Data.Char (chr)
import Data.Text (Text)
import qualified Data.Text as Text

decodeUtf8 :: Bytes.ByteString -> Text
decodeUtf8 bytes = Text.unfoldr next 0
  where
    size = Bytes.length bytes
    byte index = fromIntegral (Bytes.index bytes index) :: Int
    next :: Int -> Maybe (Char,Int)
    next index
      | index >= size = Nothing
      | lead < 0x80 = Just (chr lead,index+1)
      | lead >= 0xc2 && lead <= 0xdf = continuation (index+1) 1 (lead .&. 0x1f) 0x80 0xbf
      | lead >= 0xe0 && lead <= 0xef = continuation (index+1) 2 (lead .&. 0x0f)
          (if lead==0xe0 then 0xa0 else 0x80) (if lead==0xed then 0x9f else 0xbf)
      | lead >= 0xf0 && lead <= 0xf4 = continuation (index+1) 3 (lead .&. 0x07)
          (if lead==0xf0 then 0x90 else 0x80) (if lead==0xf4 then 0x8f else 0xbf)
      | otherwise = Just ('\xfffd',index+1)
      where lead=byte index
    continuation :: Int -> Int -> Int -> Int -> Int -> Maybe (Char,Int)
    continuation index remaining point low high
      | remaining==0 = Just (chr point,index)
      | index>=size = Just ('\xfffd',size)
      | current<low || current>high = Just ('\xfffd',index)
      | otherwise = continuation (index+1) (remaining-1) ((point `shiftL` 6)+(current .&. 0x3f)) 0x80 0xbf
      where current=byte index
