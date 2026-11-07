{-# LANGUAGE OverloadedStrings #-}
module CoercedIdentifier where
import Data.Coerce (coerce)
import Data.Text (Text)
import ProbeTypes
value :: ProbeId
value = coerce ("unchecked" :: Text)
