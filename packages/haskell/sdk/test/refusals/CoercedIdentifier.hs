{-# LANGUAGE OverloadedStrings #-}
module CoercedIdentifier where
import Data.Coerce (coerce)
import Data.Text (Text)
import Semiont.Types
value :: ResourceId
value = coerce ("unchecked" :: Text)
