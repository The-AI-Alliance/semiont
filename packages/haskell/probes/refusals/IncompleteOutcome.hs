module IncompleteOutcome where
import Data.Text (Text)
import ProbeTypes
value :: Outcome Text -> Text
value (Ready result) = result
