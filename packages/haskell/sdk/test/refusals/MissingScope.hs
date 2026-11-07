{-# LANGUAGE GADTs #-}
module MissingScope where
import Semiont.Channels
accept :: ScopeArg scope -> Channel scope payload -> Bool
accept _ = channelIsScoped
value :: Bool
value = accept NoScope MarkAdded
