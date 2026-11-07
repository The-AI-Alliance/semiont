{-# LANGUAGE OverloadedStrings #-}
module WrongOperation where
import Data.Text (Text)
import ProbeTypes
value :: IO Text
value = request RenderProbe ("wrong input" :: Text)
