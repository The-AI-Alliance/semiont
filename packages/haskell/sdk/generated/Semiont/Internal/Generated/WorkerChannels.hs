-- Generated from packages/typescript/sdk/src/claims.ts and bus descriptors. Do not edit.
module Semiont.Internal.Generated.WorkerChannels (jobClaimChannels, jobCommitChannels) where
import Data.Text (Text)
import Semiont.Bus (replyChannelsFor)
import Semiont.Channels
jobClaimChannels :: [Text]
jobClaimChannels = replyChannelsFor [SomeOperation JobClaimOperation] ++ [channelName JobQueued, channelName JobCancelRequested]
jobCommitChannels :: [Text]
jobCommitChannels = replyChannelsFor [SomeOperation MarkCommitOperation, SomeOperation BrowseAnnotationRequestedOperation]
