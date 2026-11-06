-- | The shared storage keys and sign-in document of a registry.
module Semiont.Registry.Stored
  ( StoredSession(..), knowledgeBasesKey, activeKey, openResourcesByKbKey
  , lastViewedResourceByKbKey, sessionKey, storedSession, storeSession, clearStoredSession, kbOfSessionKey, loadKnowledgeBases, saveKnowledgeBases, keptIn
  ) where
import Semiont.Internal.Stored
import Semiont.Internal.SignIn (keptIn)
