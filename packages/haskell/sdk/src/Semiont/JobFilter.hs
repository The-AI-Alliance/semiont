module Semiont.JobFilter (jobMatchesFilter) where

import Data.Aeson (ToJSON, Value(..), toJSON)
import qualified Data.Aeson.KeyMap as KM
import Semiont.Types (JobFilter)

-- A filter states only the fields it compares, at the description's own paths.
jobMatchesFilter :: ToJSON job => JobFilter -> job -> Bool
jobMatchesFilter filterValue job = states (toJSON filterValue) (toJSON job)
  where
    states (Object stated) (Object actual) = all
      (\(name, value) -> maybe False (states value) (KM.lookup name actual)) (KM.toList stated)
    states (Object _) _ = False
    states stated actual = stated == actual
