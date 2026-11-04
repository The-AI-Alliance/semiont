namespace Semiont.Testing;

/// <summary>Outputs finish on a value or refusal. Settlements finish when awaited paths return or fail.</summary>
public sealed record LivenessScenario(IReadOnlyList<Task> Outputs, IReadOnlyList<Task> Settlements,
    IDisposable? End = null) : IDisposable
{
    public void Dispose() => End?.Dispose();
}

public sealed record LivenessSpec(Func<FaultyTransport, LivenessScenario> Setup, TimeSpan Timeout, int RetryBudget,
    IReadOnlyList<IReadOnlyList<FaultAction>> Schedules, Respond? Respond = null);

public enum DeliveryOp { Write, Transition }

/// <summary>A connection model or real connection whose transitions can interleave with writes.</summary>
public interface DeliverySubject : IDisposable
{
    public void Write(string eventId);
    public void Transition();
    public Task<IReadOnlyList<string>> DeliveredAsync(CancellationToken cancellation = default);
}

public static class Liveness
{
    public static FaultAction FaultActions(Random random) => random.Next(5) switch
    {
        0 => new FaultAction.Deliver(),
        1 => new FaultAction.DropReply(),
        2 => new FaultAction.Delay(TimeSpan.FromMilliseconds(random.Next(6))),
        3 => new FaultAction.DuplicateReply(),
        _ => new FaultAction.RejectEmit(),
    };

    public static IReadOnlyList<IReadOnlyList<FaultAction>> FaultSchedules(int count, Random random) =>
        Enumerable.Range(0, count).Select(_ => (IReadOnlyList<FaultAction>)Enumerable.Range(0, random.Next(1, 9))
            .Select(_ => FaultActions(random)).ToArray()).ToArray();

    /// <summary>Checks that awaited paths settle (L2) and every output says something (L1) within the derived bound.</summary>
    public static async Task AssertLivenessAxiomsAsync(LivenessSpec spec, CancellationToken cancellation = default)
    {
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(spec.Timeout, TimeSpan.Zero);
        ArgumentOutOfRangeException.ThrowIfNegative(spec.RetryBudget);
        foreach (var schedule in spec.Schedules)
        {
            cancellation.ThrowIfCancellationRequested();
            var delays = schedule.OfType<FaultAction.Delay>().Sum(action => action.Duration.Ticks);
            var bound = TimeSpan.FromTicks(checked((spec.Timeout.Ticks * (1L + spec.RetryBudget) + delays) * 4));
            using var transport = new FaultyTransport(schedule, spec.Respond);
            using var scenario = spec.Setup(transport);
            await Task.Delay(bound, cancellation).ConfigureAwait(false);
            var under = $"under [{string.Join(", ", schedule)}] within {bound.TotalMilliseconds}ms";
            var outputs = scenario.Outputs.Select(Observe).ToArray();
            var settlements = scenario.Settlements.Select(Observe).ToArray();
            var unsettled = Array.IndexOf(settlements, false);
            if (unsettled >= 0) throw new InvalidOperationException($"L2: settlement #{unsettled} remained pending {under}.");

            foreach (var requests in transport.RequestLog.Where(entry => entry.CorrelationId is not null)
                         .GroupBy(entry => (entry.Operation, Payload: entry.Payload.GetRawText())))
            {
                var count = requests.Count();
                if (count > 1L + spec.RetryBudget)
                    throw new InvalidOperationException($"L2: '{requests.Key.Operation}' exceeded its retry budget with {count} sends {under}.");
                if (requests.Last().Action is FaultAction.DropReply or FaultAction.RejectEmit &&
                    count <= spec.RetryBudget && outputs.Length > 0 && !outputs.Contains(true))
                    throw new InvalidOperationException($"L2: '{requests.Key.Operation}' swallowed a failure {under}.");
            }

            var silent = Array.IndexOf(outputs, false);
            if (silent >= 0) throw new InvalidOperationException($"L1: output #{silent} said nothing {under}.");
        }
    }

    public static IReadOnlyList<IReadOnlyList<DeliveryOp>> DeliveryOps(int count, int longest, Random random)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(longest);
        return Enumerable.Range(0, count).Select(_ =>
        {
            var steps = Enumerable.Range(0, 1 + random.Next(longest))
                .Select(_ => random.Next(2) == 0 ? DeliveryOp.Write : DeliveryOp.Transition).ToArray();
            if (!steps.Contains(DeliveryOp.Write)) steps[random.Next(steps.Length)] = DeliveryOp.Write;
            return (IReadOnlyList<DeliveryOp>)steps;
        }).ToArray();
    }

    /// <summary>Checks that every write is delivered exactly once across transitions (L3).</summary>
    public static async Task AssertExactlyOnceDeliveryAsync(Func<DeliverySubject> setup,
        IReadOnlyList<IReadOnlyList<DeliveryOp>> interleavings, CancellationToken cancellation = default)
    {
        foreach (var steps in interleavings)
        {
            cancellation.ThrowIfCancellationRequested();
            using var subject = setup();
            var written = new List<string>();
            for (var step = 0; step < steps.Count; step++)
            {
                switch (steps[step])
                {
                    case DeliveryOp.Write:
                        var id = $"e{step}";
                        subject.Write(id);
                        written.Add(id);
                        break;
                    case DeliveryOp.Transition:
                        subject.Transition();
                        break;
                    default:
                        throw new ArgumentOutOfRangeException(nameof(interleavings), steps[step], "Unknown delivery operation");
                }
            }
            var counts = (await subject.DeliveredAsync(cancellation).ConfigureAwait(false)).CountBy(id => id)
                .ToDictionary(entry => entry.Key, entry => entry.Value);
            foreach (var id in written)
                if (counts.GetValueOrDefault(id) is var times && times != 1)
                    throw new InvalidOperationException($"L3: event '{id}' was delivered {times} times under [{string.Join(", ", steps)}].");
        }
    }

    private static bool Observe(Task path)
    {
        if (!path.IsCompleted) return false;
        _ = path.Exception;
        return true;
    }
}
