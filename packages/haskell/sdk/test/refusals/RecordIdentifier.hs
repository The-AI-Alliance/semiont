{-# LANGUAGE OverloadedStrings #-}
module RecordIdentifier where
import Semiont.Types
value :: ResourceId -> ResourceId
value identifier = identifier { resourceIdValue = "unchecked" }
