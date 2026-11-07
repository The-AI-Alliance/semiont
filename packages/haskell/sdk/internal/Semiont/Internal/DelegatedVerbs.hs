module Semiont.Internal.DelegatedVerbs (mark, yield) where

import Semiont.Internal.Delegation (Verb(..))
import Semiont.Types

mark :: Verb MarkJobCompleteCommand
mark = Verb
  (\completion -> case completion of JobCompleteCommandBranch1 value -> Just value; JobCompleteCommandBranch2 _ -> Nothing)
  (\status resource -> if jobStatusResponseType status/=JobTypeMark then Nothing else do
    result <- case jobStatusResponseResult status of
      Nothing -> Just Nothing
      Just (JobStoredResultBranch2 _) -> Just Nothing
      Just (JobStoredResultBranch1 value) -> case value of
        JobResultBranch1 done -> Just (Just (MarkJobResultBranch1 done))
        JobResultBranch2 _ -> Nothing
        JobResultBranch3 decline -> Just (Just (MarkJobResultBranch2 decline))
    pure (MarkJobCompleteCommand Nothing Nothing Nothing (jobStatusResponseJobId status) MarkJobCompleteCommandJobTypeMark resource result mempty))
yield :: Verb YieldJobCompleteCommand
yield = Verb
  (\completion -> case completion of JobCompleteCommandBranch1 _ -> Nothing; JobCompleteCommandBranch2 value -> Just value)
  (\status resource -> if jobStatusResponseType status/=JobTypeYield then Nothing else do
    result <- case jobStatusResponseResult status of
      Nothing -> Just Nothing
      Just (JobStoredResultBranch2 _) -> Just Nothing
      Just (JobStoredResultBranch1 value) -> case value of
        JobResultBranch1 _ -> Nothing
        JobResultBranch2 done -> Just (Just (YieldJobResultBranch1 done))
        JobResultBranch3 decline -> Just (Just (YieldJobResultBranch2 decline))
    pure (YieldJobCompleteCommand Nothing Nothing Nothing Nothing (jobStatusResponseJobId status) YieldJobCompleteCommandJobTypeYield resource result mempty))
