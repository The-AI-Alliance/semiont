using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.State;

public sealed class YieldStateUnit : IStateUnit
{
    private readonly SemiontClient client;
    private readonly string locale;
    private readonly UnitWork work;
    private long revision;

    public StateValue<bool> IsGenerating { get; } = new(false);
    public StateValue<JobProgress?> Progress { get; } = new(null);
    public StateValue<YieldJobDone?> Outcome { get; } = new(null);
    public StateValue<SemiontError?> Failure { get; } = new(null);
    public StateValue<JobId?> JobId { get; } = new(null);

    public YieldStateUnit(SemiontClient client, string locale)
    {
        this.client = client;
        this.locale = locale;
        work = new UnitWork(client.Transport.Closed);
    }

    public void Generate(GenerationJobParams parameters, int? stallDeadlineMs = null)
    {
        lock (work.Gate)
        {
            if (!work.Active) return;
            IsGenerating.Set(false);
            Progress.Set(null);
            Outcome.Set(null);
            Failure.Set(null);
            JobId.Set(null);
            var written = string.IsNullOrEmpty(parameters.Language) ? parameters with { Language = locale } : parameters;
            var run = client.Yield.Delegate(written, stallDeadlineMs);
            var selected = ++revision;
            work.Run(token => FollowAsync(run, selected, token));
        }
    }

    public void DismissProgress()
    {
        lock (work.Gate)
        {
            if (!work.Active) return;
            Progress.Set(null);
            Outcome.Set(null);
            Failure.Set(null);
        }
    }

    private async Task FollowAsync(Delegation<YieldJobCompleteCommand> run, long selected, CancellationToken cancellation)
    {
        try
        {
            await foreach (var update in run.WithCancellation(cancellation).ConfigureAwait(false))
            {
                lock (work.Gate)
                {
                    if (!work.Active || revision != selected) return;
                    switch (update)
                    {
                        case JobEvent<YieldJobCompleteCommand>.Created(var created): JobId.Set(created.JobId); break;
                        case JobEvent<YieldJobCompleteCommand>.Progress(var progress):
                            Progress.Set(progress);
                            IsGenerating.Set(true);
                            break;
                        case JobEvent<YieldJobCompleteCommand>.Complete({ Result: YieldJobResult.YieldJobDoneCase(var outcome) }):
                            Outcome.Set(outcome);
                            break;
                    }
                }
            }
        }
        catch (SemiontError failure)
        {
            lock (work.Gate)
            {
                if (!work.Active || revision != selected) return;
                Failure.Set(failure);
                if (!DisplayFailure.WasCancelled(failure)) Progress.Set(null);
            }
        }
        finally
        {
            lock (work.Gate)
            {
                if (work.Active && revision == selected)
                {
                    JobId.Set(null);
                    IsGenerating.Set(false);
                }
            }
        }
    }

    public void Dispose()
    {
        lock (work.Gate)
        {
            work.Dispose();
            IsGenerating.Close();
            Progress.Close();
            Outcome.Close();
            Failure.Close();
            JobId.Close();
        }
    }
}

internal static class DisplayFailure
{
    internal static bool WasCancelled(SemiontError error) => error is JobError && error.Code == Protocol.ProtocolFacts.JobError("cancelled");
}
