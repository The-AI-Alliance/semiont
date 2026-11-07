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
        await foreach (var carried in events.Reader.ReadAllAsync(cancellation).ConfigureAwait(false))
        {
            lock (work.Gate)
            {
                if (!work.Active) return;
                // A frame refused, or one whose payload is not its channel's, is nobody's to act on.
                if (carried.Channel == BusChannels.BrowseClick.Name)
                {
                    if (Bus.HeardOf<BrowseClickEvent>(carried) is Heard<BrowseClickEvent>.Delivered click) Focus(click.Payload.AnnotationId);
                }
                else if (Bus.HeardOf<BeckonHoverEvent>(carried) is Heard<BeckonHoverEvent>.Delivered hover)
                {
                    var annotation = hover.Payload.AnnotationId;
                    HoveredAnnotationId.Set(annotation);
                    if (annotation is { } id)
                        client.Bus.Emit(BusChannels.BeckonSparkle, new BeckonSparkleEvent { AnnotationId = id });
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
            HoveredAnnotationId.Close();
        }
    }
}
