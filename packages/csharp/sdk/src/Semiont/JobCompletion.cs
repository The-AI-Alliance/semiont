using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont;

internal static class JobCompletion
{
    internal static MarkJobCompleteCommand Mark(JobCompleteCommand completion) =>
        completion is JobCompleteCommand.MarkJobCompleteCommandCase(var mark) ? mark : throw WrongVerb();

    internal static YieldJobCompleteCommand Yield(JobCompleteCommand completion) =>
        completion is JobCompleteCommand.YieldJobCompleteCommandCase(var yield) ? yield : throw WrongVerb();

    internal static JobCompleteCommand FromStatus(JobStatusResponse status, ResourceId resource)
    {
        var result = status.Result switch
        {
            null or JobStoredResult.ObjectCase => null,
            JobStoredResult.JobResultCase(var value) => value,
        };
        return status.Type switch
        {
            JobType.Mark => new JobCompleteCommand.MarkJobCompleteCommandCase(new MarkJobCompleteCommand
            {
                JobId = status.JobId,
                ResourceId = resource,
                Result = result switch
                {
                    null => null,
                    JobResult.MarkJobDoneCase(var done) => new MarkJobResult.MarkJobDoneCase(done),
                    JobResult.JobDeclinedCase(var declined) => new MarkJobResult.JobDeclinedCase(declined),
                    _ => throw WrongVerb(),
                },
            }),
            JobType.Yield => new JobCompleteCommand.YieldJobCompleteCommandCase(new YieldJobCompleteCommand
            {
                JobId = status.JobId,
                ResourceId = resource,
                Result = result switch
                {
                    null => null,
                    JobResult.YieldJobDoneCase(var done) => new YieldJobResult.YieldJobDoneCase(done),
                    JobResult.JobDeclinedCase(var declined) => new YieldJobResult.JobDeclinedCase(declined),
                    _ => throw WrongVerb(),
                },
            }),
            _ => throw WrongVerb(),
        };
    }

    internal static JobId Id(JobCompleteCommand completion) => completion switch
    {
        JobCompleteCommand.MarkJobCompleteCommandCase(var mark) => mark.JobId,
        JobCompleteCommand.YieldJobCompleteCommandCase(var yield) => yield.JobId,
    };

    private static TransportError WrongVerb() => new(ProtocolFacts.Error(0), "The job's completion is not the delegated verb's.");
}
