{-# LANGUAGE OverloadedStrings #-}
module Semiont.Internal.Annotations.Id (annotationIdFor) where

import Crypto.Hash (Digest, SHA256, hash)
import qualified Data.ByteArray as Memory
import qualified Data.ByteString.Base64.URL as Base64
import Data.Aeson (Value(..), object, (.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.Char (ord)
import Data.Foldable (toList)
import Data.List (sortOn)
import Data.Scientific (floatingOrInteger)
import Data.Text (Text)
import qualified Data.Text as Text
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import Numeric (showHex)
import Semiont.Types (ResourceId, Motivation, AnnotationId, mkAnnotationId)

canonical :: Value -> Either String Text
canonical (Object fields) = do
  members <- traverse (\(name,value)->do key<-canonical (String (Key.toText name)); item<-canonical value; pure (key<>":"<>item)) (sortOn (Key.toText . fst) (KM.toList fields))
  pure ("{"<>Text.intercalate "," members<>"}")
canonical (Array values) = (\items->"["<>Text.intercalate "," items<>"]") <$> traverse canonical (toList values)
canonical (Number number) = case floatingOrInteger number :: Either Double Integer of
  Right whole -> Right (Text.pack (show whole))
  Left _ -> Left "An annotation body contains a fractional number; annotation IDs require whole numbers"
canonical (String value) = Right ("\""<>Text.concatMap quoted value<>"\"")
  where
    quoted '"'="\\\""; quoted '\\'="\\\\"; quoted '\b'="\\b"; quoted '\t'="\\t"; quoted '\n'="\\n"; quoted '\f'="\\f"; quoted '\r'="\\r"
    quoted char | char<'\x20' = let digits=showHex (ord char) "" in "\\u"<>Text.pack (replicate (4-length digits) '0'<>digits)
                | otherwise=Text.singleton char
canonical (Bool True)=Right "true"
canonical (Bool False)=Right "false"
canonical Null=Right "null"

annotationIdFor :: ResourceId -> Motivation -> Text -> Maybe Value -> Either String AnnotationId
annotationIdFor resource motivation anchor body = do
  bytes <- encodeUtf8 <$> canonical (object (["resourceId" .= resource,"motivation" .= motivation,"anchor" .= anchor]
    ++maybe [] (\value->["body" .= value]) body))
  mkAnnotationId (Text.take 21 (decodeUtf8 (Base64.encodeUnpadded (Memory.convert (hash bytes :: Digest SHA256)))))
