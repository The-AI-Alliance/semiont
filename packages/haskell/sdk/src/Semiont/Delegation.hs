-- | Typed job lifecycle reports and job-following failures.
module Semiont.Delegation (JobEvent(..), UploadEvent(..), JobError(..), deriveStallDeadlineMs) where
import Semiont.Internal.Delegation
