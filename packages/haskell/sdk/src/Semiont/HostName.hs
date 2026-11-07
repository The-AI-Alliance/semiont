module Semiont.HostName (isValidHostname) where

import Data.Text (Text)
import qualified Data.Text as T

isValidHostname :: Text -> Bool
isValidHostname = all validLabel . T.splitOn (T.singleton '.')
  where
    alphaNumeric c = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
    validLabel label = T.length label <= 63 && T.all (\c -> alphaNumeric c || c == '-') label &&
      case (T.uncons label, T.unsnoc label) of
        (Just (first, _), Just (_, lastCharacter)) -> alphaNumeric first && alphaNumeric lastCharacter
        _ -> False
