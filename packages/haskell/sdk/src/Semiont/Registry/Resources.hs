-- | Open resources are per knowledge base. A failed check is not evidence
-- that a resource is gone; only an affirmative not-found verdict removes it.
module Semiont.Registry.Resources (OpenResource(..), TabCheck(..), TabVerdict(..), applyTabChecks, sortOpenResources) where

import Data.List (sortOn)
import qualified Data.Map.Strict as Map
import Semiont.Types

applyTabChecks :: [OpenResource] -> Map.Map ResourceId TabCheck -> [OpenResource]
applyTabChecks opened checks=concatMap apply opened
  where
    apply resource=case Map.lookup (openResourceId resource) checks of
      Just (TabCheckBranch1 _) -> []
      Just (TabCheckBranch2 checked) -> [resource { openResourceName=tabCheckBranch2ValueName checked
        ,openResourceMediaType=case tabCheckBranch2ValueMediaType checked of Nothing->openResourceMediaType resource; Just media->Just media }]
      Just (TabCheckBranch3 _) -> [resource]
      Nothing -> [resource]

sortOpenResources :: [OpenResource] -> [OpenResource]
sortOpenResources=sortOn (\resource->(openResourceOrder resource,openResourceOpenedAt resource))
