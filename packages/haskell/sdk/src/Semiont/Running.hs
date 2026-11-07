-- | A lazy operation, consumed once by awaiting its result or following reports.
-- 'withReports' cancels and joins the operation when its consumer leaves scope.
module Semiont.Running (Running, ConsumptionError(..), await, withReports) where

import Semiont.Internal.Running
