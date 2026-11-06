{-# LANGUAGE OverloadedStrings, ScopedTypeVariables #-}
module Semiont.Internal.Text (decodeRepresentation) where

import Control.Exception (IOException, catch, throwIO)
import qualified Data.ByteString as Bytes
import Data.Char (chr)
import qualified Data.Vector as Vector
import qualified Data.Map.Strict as Map
import Data.Text (Text)
import qualified Data.Text as Text
import GHC.Foreign (peekCStringLen)
import GHC.IO.Encoding (mkTextEncoding)
import qualified Semiont.Internal.Utf8 as Utf8
import qualified Semiont.ErrorCodes as Code
import Semiont.Errors (TransportError(..))
import qualified Semiont.Internal.Generated.Text as Fact
import qualified Semiont.MediaTypes as Media

asciiLower :: Text -> Text
asciiLower = Text.map (\c -> if c>='A'&&c<='Z' then chr (fromEnum c+32) else c)
httpWhite :: Char -> Bool
httpWhite c = c `elem` ("\n\r\t " :: String)
asciiWhite :: Char -> Bool
asciiWhite c = c `elem` ("\t\n\f\r " :: String)
token :: Text -> Bool
token text = not (Text.null text) && Text.all (\c -> (c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c `elem` ("!#$%&'*+-.^_`|~"::String)) text
parameterValue :: Char -> Bool
parameterValue c = c=='\t'||(c>=' '&&c<='~')||(c>='\x80'&&c<='\xff')

quoted :: String -> (String,String)
quoted [] = ([],[])
quoted ('"':rest) = ([],rest)
quoted ('\\':next:rest) = let (value,remaining)=quoted rest in (next:value,remaining)
quoted ['\\'] = ([],[])
quoted (next:rest) = let (value,remaining)=quoted rest in (next:value,remaining)
charset :: Text -> Maybe Text
charset original = do
  let text = Text.dropAround httpWhite original
      (kind,slash)=Text.breakOn "/" text
      (subtype,parameters)=Text.breakOn ";" (Text.drop 1 slash)
  if Text.null slash || not (token kind && token (Text.dropWhileEnd httpWhite subtype)) then Nothing else parametersOf (Text.unpack parameters)
  where
    parametersOf [] = Nothing
    parametersOf (_:afterSemi) =
      let start=dropWhile httpWhite afterSemi
          (name,remaining)=break (\c -> c==';'||c=='=') start
      in case remaining of
        [] -> Nothing
        ';':_ -> parametersOf remaining
        _:body -> case body of
          [] -> Nothing
          '"':rest -> let (value,tail')=quoted rest in accept name value (dropWhile (/=';') tail')
          _ -> let (raw,tail')=break (==';') body
                   value=reverse (dropWhile httpWhite (reverse raw))
               in if null value then parametersOf tail' else accept name value tail'
    accept name value rest
      | asciiLower (Text.pack name)=="charset" && all parameterValue value = Just (Text.pack value)
      | otherwise = parametersOf rest

-- A non-surrogate unit after a leading surrogate is reconsumed as a whole unit.
decodeUtf16 :: Bool -> Bytes.ByteString -> Text
decodeUtf16 bigEndian bytes = Text.unfoldr next 0
  where
    size = Bytes.length bytes
    unit index = let first=fromIntegral (Bytes.index bytes index)
                     second=fromIntegral (Bytes.index bytes (index+1))
                 in if bigEndian then first*256+second else second*256+first
    next index
      | index >= size = Nothing
      | index+1 >= size = Just ('\xfffd',size)
      | current >= 0xd800 && current <= 0xdbff =
          if index+3 >= size then Just ('\xfffd',size)
          else let following=unit (index+2)
               in if following >= 0xdc00 && following <= 0xdfff
                  then Just (chr (0x10000+(current-0xd800)*1024+following-0xdc00),index+4)
                  else Just ('\xfffd',index+2)
      | current >= 0xdc00 && current <= 0xdfff = Just ('\xfffd',index+2)
      | otherwise = Just (chr current,index+2)
      where current=unit index

refuse :: Text -> IO value
refuse message = throwIO (TransportError Code.TransportError message Nothing Nothing)
decodeRepresentation :: Bytes.ByteString -> Text -> IO Text
decodeRepresentation bytes contentType = do
  let base=Media.baseMediaType contentType
  case Media.textSourceOf contentType of
    Media.PdfTextLayer -> refuse ("The resource is "<>base<>", whose text is derived from its bytes: read its anchored text instead")
    Media.None -> refuse ("The resource is "<>base<>", which has no text: read its bytes instead")
    Media.Decode -> pure ()
  encoding <- case charset contentType of
    Nothing -> pure "utf-8"
    Just "" -> pure "utf-8"
    Just stated -> case Map.lookup (asciiLower (Text.dropAround asciiWhite stated)) Fact.encodingOf of
      Just name | name `notElem` Fact.refused -> pure name
      _ -> refuse ("The resource's text is "<>stated<>", which is no charset the Encoding Standard decodes")
  let decode name data' = case name of
        "utf-8" -> pure (Utf8.decodeUtf8 data')
        "utf-16be" -> pure (decodeUtf16 True data')
        "utf-16le" -> pure (decodeUtf16 False data')
        _ -> case Map.lookup name Fact.singleByte of
          Just points -> pure (Text.unfoldrN (Bytes.length data') (\index -> if index >= Bytes.length data' then Nothing else Just (chr (points Vector.! fromIntegral (Bytes.index data' index)), index+1)) 0)
          Nothing -> do
            -- The platform supplies the seven legacy multi-byte decoders.
            -- Their labels still come exclusively from the Encoding Standard.
            let codec = case name of
                  "big5" -> "BIG5-HKSCS"
                  "euc-kr" -> "CP949"
                  "gbk" -> "GB18030"
                  "shift_jis" -> "CP932"
                  _ -> Text.unpack name
            (do decoder <- mkTextEncoding (codec<>"//ROUNDTRIP")
                Text.pack <$> Bytes.useAsCStringLen data' (peekCStringLen decoder))
              `catch` (\(_::IOException) -> refuse ("The resource's text is "<>name<>", which this platform cannot decode"))
  if Bytes.pack [239,187,191] `Bytes.isPrefixOf` bytes then decode "utf-8" (Bytes.drop 3 bytes)
    else if Bytes.pack [254,255] `Bytes.isPrefixOf` bytes then decode "utf-16be" (Bytes.drop 2 bytes)
    else if Bytes.pack [255,254] `Bytes.isPrefixOf` bytes then decode "utf-16le" (Bytes.drop 2 bytes)
    else decode encoding bytes
