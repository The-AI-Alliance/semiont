using System.Text.Json;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont.State;

public sealed class HoverDwell : IStateUnit
{
    private readonly UnitWork work = new();
    private readonly Action<AnnotationId?> say;
    private readonly TimeProvider clock;
    private readonly TimeSpan delay;
    private CancellationTokenSource? resting;
    private AnnotationId? hovered;

    public HoverDwell(Action<AnnotationId?> say, TimeSpan? delay = null, TimeProvider? timeProvider = null)
    {
        this.say = say;
        this.delay = delay ?? TimeSpan.FromMilliseconds(ProtocolFacts.Timing("hoverDelayMs").GetInt32());
        ArgumentOutOfRangeException.ThrowIfLessThan(this.delay, TimeSpan.Zero);
        clock = timeProvider ?? TimeProvider.System;
    }

    public void Enter(AnnotationId annotationId)
    {
        lock (work.Gate)
        {
            if (!work.Active) return;
            CancelRest();
            if (hovered == annotationId) return;
            var next = CancellationTokenSource.CreateLinkedTokenSource(work.Token);
            resting = next;
            work.Run(_ => RestAsync(annotationId, next));
        }
    }

    public void Leave()
    {
        lock (work.Gate)
        {
            if (!work.Active) return;
            CancelRest();
            if (hovered is null) return;
            hovered = null;
            say(null);
        }
    }

    private async Task RestAsync(AnnotationId annotation, CancellationTokenSource rest)
    {
        try
        {
            await Task.Delay(delay, clock, rest.Token).ConfigureAwait(false);
            lock (work.Gate)
            {
                if (!work.Active || resting != rest) return;
                hovered = annotation;
                resting = null;
                say(annotation);
            }
        }
        finally
        {
            lock (work.Gate)
            {
                if (resting == rest) resting = null;
                rest.Dispose();
            }
        }
    }

    private void CancelRest()
    {
        var current = resting;
        resting = null;
        current?.Cancel();
    }

    public void Dispose() => work.Dispose();
}

public sealed class BeckonStateUnit : IStateUnit
{
    private readonly SemiontClient client;
    private readonly ResourceId resourceId;
    private readonly UnitWork work;
    private readonly EventBus.Subscription events;
    public StateValue<AnnotationId?> HoveredAnnotationId { get; } = new(null);

    public BeckonStateUnit(SemiontClient client, ResourceId resourceId)
    {
        this.client = client;
        this.resourceId = resourceId;
        work = new UnitWork(client.Transport.Closed);
        events = client.Bus.Listen([BusChannels.BeckonHover.Name, BusChannels.BrowseClick.Name]);
        work.Run(ReadAsync);
    }

    public void Focus(AnnotationId? annotationId = null)
    {
        lock (work.Gate)
        {
            if (work.Active) client.Bus.Emit(BusChannels.BeckonFocus, new BeckonFocusEvent { ResourceId = resourceId, AnnotationId = annotationId });
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
                    if (received.Frame.Channel == BusChannels.BrowseClick.Name)
                        Focus(Bus.Decode<BrowseClickEvent>(received.Frame.Payload).AnnotationId);
                    else
                    {
                        var annotation = Bus.Decode<BeckonHoverEvent>(received.Frame.Payload).AnnotationId;
                        HoveredAnnotationId.Set(annotation);
                        if (annotation is { } id)
                            client.Bus.Emit(BusChannels.BeckonSparkle, new BeckonSparkleEvent { AnnotationId = id });
                    }
                }
                catch (JsonException) { /* An invalid event cannot move attention. */ }
            }
        }
    }

    public void Dispose()
    {
        lock (work.Gate)
        {
            work.Dispose();
            events.Dispose();
            HoveredAnnotationId.Close();
        }
    }
}
