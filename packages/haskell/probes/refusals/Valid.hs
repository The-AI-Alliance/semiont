{-# LANGUAGE OverloadedStrings #-}
module Valid where
import Data.Text (Text)
import ProbeTypes
value :: IO Bool
value = receive NoScope GlobalProbe
rendered :: IO Text
rendered = request RenderProbe 12
identifier :: Maybe ProbeId
identifier = parseProbeId "valid"
