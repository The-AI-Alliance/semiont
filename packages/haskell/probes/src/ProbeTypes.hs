{-# LANGUAGE DataKinds #-}
{-# LANGUAGE GADTs #-}
{-# LANGUAGE KindSignatures #-}

module ProbeTypes
  ( ProbeId, parseProbeId, Scope(..), ScopeArg(..), Channel(..), receive
  , Operation(..), request, Outcome(..), describe
  ) where

import Data.Text (Text)
import qualified Data.Text as Text

-- Synthetic values test Haskell's type boundaries without restating a wire schema.
newtype ProbeId = ProbeId Text deriving (Eq, Show)

parseProbeId :: Text -> Maybe ProbeId
parseProbeId value
  | Text.null value = Nothing
  | otherwise = Just (ProbeId value)

data Scope = Global | Scoped

data ScopeArg (scope :: Scope) where
  NoScope :: ScopeArg 'Global
  InScope :: ProbeId -> ScopeArg 'Scoped

data Channel (scope :: Scope) payload where
  GlobalProbe :: Channel 'Global Bool
  ScopedProbe :: Channel 'Scoped Int

receive :: ScopeArg scope -> Channel scope payload -> IO payload
receive NoScope GlobalProbe = pure True
receive (InScope _) ScopedProbe = pure 1

data Operation input output where
  RenderProbe :: Operation Int Text

request :: Operation input output -> input -> IO output
request RenderProbe value = pure (Text.pack (show value))

data Outcome value = Pending | Ready value | Failed Text

describe :: Outcome Text -> Text
describe Pending = Text.pack "pending"
describe (Ready value) = value
describe (Failed reason) = reason
