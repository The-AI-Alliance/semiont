using System.Text.Json;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont.State;

public sealed record PendingAnnotation(AnnotationSelector Selector, Motivation Motivation);

public sealed class MarkStateUnit : IStateUnit
{
    private readonly SemiontClient client;
    private readonly ResourceId resourceId;
    private readonly UnitWork work;
    private readonly EventBus.Subscription events;
    private readonly TimeProvider clock;
    private static readonly TimeSpan Silence = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("delegateSilenceMs").GetInt32());
    private long revision;

    public StateValue<PendingAnnotation?> PendingAnnotation { get; } = new(null);
    public StateValue<Motivation?> DelegatingMotivation { get; } = new(null);
    public StateValue<JobProgress?> Progress { get; } = new(null);
    public StateValue<Motivation?> ProgressMotivation { get; } = new(null);
    public StateValue<SemiontError?> Failure { get; } = new(null);
    public StateValue<JobId?> JobId { get; } = new(null);

    public MarkStateUnit(SemiontClient client, ResourceId resourceId)
    {
        this.client = client;
        this.resourceId = resourceId;
        clock = client.Transport.Clock;
        work = new UnitWork(client.Transport.Closed);
        events = client.Bus.Listen([BusChannels.MarkRequested.Name, BusChannels.MarkSubmit.Name]);
        work.Run(ReadAsync);
    }

    public void RequestDelegate(MarkJobParams parameters)
    {
        lock (work.Gate)
        {
            if (!work.Active) return;
            var motivation = parameters switch
            {
                MarkJobParams.HighlightingJobParamsCase => Motivation.Highlighting,
                MarkJobParams.CommentingJobParamsCase => Motivation.Commenting,
                MarkJobParams.AssessingJobParamsCase => Motivation.Assessing,
                MarkJobParams.LinkingJobParamsCase => Motivation.Linking,
                MarkJobParams.TaggingJobParamsCase => Motivation.Tagging,
            };
            DelegatingMotivation.Set(motivation);
            Progress.Set(null);
            ProgressMotivation.Set(motivation);
            Failure.Set(null);
            JobId.Set(null);
            var run = client.Mark.Delegate(resourceId, parameters);
            var selected = ++revision;
            work.Run(token => FollowAsync(run, motivation, selected, token));
        }
    }

    public void CancelPending()
    {
        lock (work.Gate)
            if (work.Active) PendingAnnotation.Set(null);
    }

    public void DismissProgress()
    {
        lock (work.Gate)
        {
            if (!work.Active) return;
            Progress.Set(null);
            ProgressMotivation.Set(null);
            Failure.Set(null);
        }
    }

    private async Task ReadAsync(CancellationToken cancellation)
    {
        await foreach (var received in events.Reader.ReadAllAsync(cancellation).ConfigureAwait(false))
        {
            lock (work.Gate)
            {
                if (!work.Active) return;
                try
                {
                    if (received.Frame.Channel == BusChannels.MarkRequested.Name)
                    {
                        var request = Bus.Decode<MarkRequestedEvent>(received.Frame.Payload);
                        if (request.Source == resourceId) PendingAnnotation.Set(new PendingAnnotation(request.Selector, request.Motivation));
                    }
                    else
                    {
                        var submission = Bus.Decode<MarkSubmitEvent>(received.Frame.Payload);
                        if (submission.Source == resourceId)
                        {
                            var composed = PendingAnnotation.Value;
                            work.Run(token => CreateAsync(submission, composed, token));
                        }
                    }
                }
                catch (JsonException) { /* An invalid event cannot create an annotation. */ }
            }
        }
    }

    private async Task CreateAsync(MarkSubmitEvent submission, PendingAnnotation? composed, CancellationToken cancellation)
    {
        var target = new AnnotationTarget { Source = resourceId, Selector = submission.Selector };
        try
        {
            await client.Mark.AnnotationAsync(new CreateAnnotationRequest
            {
                Target = target,
                Motivation = submission.Motivation,
                Body = submission.Body,
            }, cancellation).ConfigureAwait(false);
            lock (work.Gate)
                if (work.Active && ReferenceEquals(PendingAnnotation.Value, composed)) PendingAnnotation.Set(null);
        }
        catch (SemiontError failure)
        {
            lock (work.Gate)
                if (work.Active) client.Bus.Emit(BusChannels.MarkCreateError,
                    new ResourceErrorEvent { ResourceId = resourceId, Message = failure.Message });
        }
    }

    private async Task FollowAsync(Delegation<MarkJobCompleteCommand> run, Motivation motivation, long selected, CancellationToken token)
    {
        try
        {
            await using var reader = run.GetAsyncEnumerator(token);
            while (true)
            {
                var next = reader.MoveNextAsync().AsTask();
                using (var waiting = CancellationTokenSource.CreateLinkedTokenSource(token))
                {
                    var quiet = Task.Delay(Silence, clock, waiting.Token);
                    if (await Task.WhenAny(next, quiet).ConfigureAwait(false) == quiet && !token.IsCancellationRequested && !next.IsCompleted)
                    {
                        lock (work.Gate)
                        {
                            if (work.Active && revision == selected)
                            {
                                if (Progress.Value is null) Progress.Set(new JobProgress { Percentage = 0 });
                                client.Bus.Emit(BusChannels.MarkDelegateTimeout,
                                    new MarkDelegateTimeoutEvent { ResourceId = resourceId, Motivation = motivation });
                            }
                        }
                    }
                    waiting.Cancel();
                }
                if (!await next.ConfigureAwait(false)) return;
                lock (work.Gate)
                {
                    if (!work.Active || revision != selected) return;
                    switch (reader.Current)
                    {
                        case JobEvent<MarkJobCompleteCommand>.Created(var created): JobId.Set(created.JobId); break;
                        case JobEvent<MarkJobCompleteCommand>.Progress(var progress): Progress.Set(progress); break;
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
                if (!DisplayFailure.WasCancelled(failure))
                {
                    Progress.Set(null);
                    ProgressMotivation.Set(null);
                }
            }
        }
        finally
        {
            lock (work.Gate)
            {
                if (work.Active && revision == selected)
                {
                    DelegatingMotivation.Set(null);
                    JobId.Set(null);
                }
            }
        }
    }

    public void Dispose()
    {
        lock (work.Gate)
        {
            work.Dispose();
            events.Dispose();
            PendingAnnotation.Close();
            DelegatingMotivation.Close();
            Progress.Close();
            ProgressMotivation.Close();
            Failure.Close();
            JobId.Close();
        }
    }
}
