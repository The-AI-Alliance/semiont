-- Generated from client/surface.json; do not edit.
module Semiont.Internal.Generated.SessionFactoryOptions where
import Semiont.Types (KnowledgeBase)
import qualified Semiont.SessionStorage as Storage
import qualified Semiont.State.SessionSignals as Signals
data SessionFactoryOptions = SessionFactoryOptions
  { sessionFactoryOptionsKb :: KnowledgeBase
  , sessionFactoryOptionsStorage :: Storage.SessionStorage
  , sessionFactoryOptionsSignals :: Signals.SessionSignals
  }
