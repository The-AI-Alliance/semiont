-- | JSON object membership when a property is both optional and nullable.
module Semiont.Types.Presence (Presence(..)) where

data Presence value = Absent | Null | Present value
  deriving (Eq, Show)
