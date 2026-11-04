using Semiont.Errors;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont.Namespaces;

public sealed class YieldNamespace
{
    private readonly JobFollower follower;

    internal YieldNamespace(JobFollower follower) => this.follower = follower;

    /// <summary>Follows generation grounded in the supplied context. The stall deadline applies locally.</summary>
    public Delegation<YieldJobCompleteCommand> Delegate(GenerationJobParams parameters, int? stallDeadlineMs = null)
    {
        var resource = parameters.Context.Focus switch
        {
            GatheredContextFocus.ResourceCase(var focus) => focus.Resource.Id,
            GatheredContextFocus.AnnotationCase(var focus) => focus.SourceResource.Id,
        };
        var stall = stallDeadlineMs ?? GenerationStallMs(parameters.MaxTokens);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(stall);
        return follower.Follow(new JobCreateCommand.YieldJobCreateCommandCase(new YieldJobCreateCommand
        {
            Params = parameters,
        }), resource, JobCompletion.Yield, stall);
    }

    private static int GenerationStallMs(double? maxTokens)
    {
        var tokens = Math.Max(0, maxTokens ?? ProtocolFacts.Timing("generationStallAssumedTokensCount").GetInt32());
        var duration = Math.Round(tokens * ProtocolFacts.Timing("generationStallPerTokenMs").GetInt32(), MidpointRounding.AwayFromZero);
        if (!double.IsFinite(duration) || duration > int.MaxValue)
            throw new TransportError(ProtocolFacts.Error(0), "The generation's stall deadline cannot be represented.");
        return Math.Max(ProtocolFacts.Timing("generationStallFloorMs").GetInt32(), (int)duration);
    }
}
