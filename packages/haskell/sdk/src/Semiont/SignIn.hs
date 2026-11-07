-- | A knowledge base's kept grant, with atomic renewal and sign-out.
module Semiont.SignIn (KeptSignIn(..), newMemorySignIn, renewKept) where
import Semiont.Internal.SignIn
