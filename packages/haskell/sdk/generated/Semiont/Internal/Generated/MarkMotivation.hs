-- Generated from MarkJobParams.json and Motivation.json; do not edit.
module Semiont.Internal.Generated.MarkMotivation (markMotivation) where
import Semiont.Types (MarkJobParams(..), Motivation(..))
markMotivation :: MarkJobParams -> Motivation
markMotivation (MarkJobParamsBranch1 _) = MotivationHighlighting
markMotivation (MarkJobParamsBranch2 _) = MotivationCommenting
markMotivation (MarkJobParamsBranch3 _) = MotivationAssessing
markMotivation (MarkJobParamsBranch4 _) = MotivationLinking
markMotivation (MarkJobParamsBranch5 _) = MotivationTagging
