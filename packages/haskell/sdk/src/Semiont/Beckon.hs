module Semiont.Beckon (BeckonNamespace, newBeckon, attention, click, openResource, sparkleAll, hover, sparkle) where

import Control.Concurrent.STM (STM)
import qualified Semiont.Bus as Bus
import Semiont.Channels
import Semiont.EventBus (EventBus)
import qualified Semiont.Internal.Local as Local
import Semiont.Types

data BeckonNamespace = BeckonNamespace Bus.Bus EventBus
newBeckon :: Bus.Bus -> EventBus -> BeckonNamespace
newBeckon = BeckonNamespace
attention :: BeckonNamespace -> ResourceId -> Maybe AnnotationId -> IO (Maybe Integer)
attention (BeckonNamespace wire _) resource annotation = Bus.emit wire BeckonFocus (BeckonFocusEvent annotation resource mempty) NoScope Nothing
click :: BeckonNamespace -> AnnotationId -> IO (Maybe Integer)
click (BeckonNamespace wire _) annotation = Bus.emit wire BrowseClick (BrowseClickEvent annotation mempty) NoScope Nothing
openResource :: BeckonNamespace -> ResourceId -> IO (Maybe Integer)
openResource (BeckonNamespace wire _) resource = Bus.emit wire BrowseResourceOpen (BrowseResourceOpenEvent resource mempty) NoScope Nothing
sparkleAll :: BeckonNamespace -> AnnotationId -> IO (Maybe Integer)
sparkleAll (BeckonNamespace wire _) annotation = Bus.emit wire BeckonSparkle (BeckonSparkleEvent annotation mempty) NoScope Nothing
hover :: BeckonNamespace -> Maybe AnnotationId -> STM ()
hover (BeckonNamespace _ bus) annotation = Local.signal bus BeckonHover (BeckonHoverEvent annotation mempty) NoScope
sparkle :: BeckonNamespace -> AnnotationId -> STM ()
sparkle (BeckonNamespace _ bus) annotation = Local.signal bus BeckonSparkle (BeckonSparkleEvent annotation mempty) NoScope
