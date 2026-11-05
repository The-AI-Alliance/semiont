using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Semiont;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Jobs;
using Semiont.Types;

internal sealed class WorkerDriver : IDisposable
{
    private static readonly ActivitySource Activities = new("semiont");
    private static readonly JsonSerializerOptions TimingJson = new() { PropertyNameCaseInsensitive = true };
    private static readonly JsonSerializerOptions CamelJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly object gate = new();
    private readonly List<IDisposable> scopes = [];
    private SemiontClient? client;
    private Claims? claims;
    private Held? held;

    internal async Task RunAsync(JsonElement args)
    {
        var id = args.GetProperty("id").GetInt64();
        try
        {
            object? answer = null;
            switch (Text(args, "op"))
            {
                case "open":
                    if (client is not null) throw new InvalidOperationException("A client is already open.");
                    var timing = args.TryGetProperty("timing", out var values) ? values.Deserialize<Timing>(TimingJson) : null;
                    var commits = args.TryGetProperty("commits", out var enabled) && enabled.GetBoolean();
                    var channels = commits ? WorkerRules.JobClaimChannels.Concat(WorkerRules.JobCommitChannels) : WorkerRules.JobClaimChannels;
                    var transport = new HttpTransport(Text(args, "baseUrl"), Text(args, "token"), channels, timing);
                    client = new SemiontClient(transport);
                    _ = ReportStatesAsync(transport);
                    _ = ReportErrorsAsync(transport);
                    break;
                case "close":
                    if (claims is not null) await claims.StopAsync().ConfigureAwait(false);
                    Dispose();
                    break;
                case "claim":
                    if (claims is not null) throw new InvalidOperationException("This worker already claims.");
                    claims = (client ?? throw new InvalidOperationException("No client is open.")).Job.Claim(Required<JobFilter[]>(args, "accepts"));
                    _ = ReportJobsAsync(claims);
                    _ = ReportRefusalsAsync(claims);
                    _ = ReportStallsAsync(claims);
                    break;
                case "vitals":
                    answer = (claims ?? throw new InvalidOperationException("No claims have started.")).Vitals();
                    break;
                case "subscribe-resource":
                    var active = client ?? throw new InvalidOperationException("No client is open.");
                    scopes.Add(active.Transport.SubscribeToResource(ResourceId.Parse(Text(args, "resource"))));
                    break;
                case "sync": break;
                default: await SayForJobAsync(args).ConfigureAwait(false); break;
            }
            WireDriver.Say(new JsonObject { ["id"] = id, ["ok"] = JsonSerializer.SerializeToNode(answer, CamelJson) });
        }
        catch (SemiontError error) { WireDriver.Say(new { id, error = new { code = error.Code, status = error.Status, detail = error.Message } }); }
        catch (Exception error) { WireDriver.Say(new { id, misuse = error.Message }); }
    }

    private async Task ReportJobsAsync(Claims worker)
    {
        while (await worker.NextAsync().ConfigureAwait(false) is { } job)
        {
            var previous = Activity.Current;
            var verb = JsonSerializer.SerializeToElement(job.JobType).GetString();
            var span = Activities.StartActivity("job:" + verb, ActivityKind.Internal, job.Trace,
                new ActivityTagsCollection { ["job.id"] = job.JobId.Value });
            Activity.Current = previous;
            var cancellation = job.Cancelled.Register(() => WireDriver.Say(new { signalled = job.JobId.Value }));
            lock (gate)
            {
                held?.Dispose();
                held = new Held(job, span, cancellation);
                WireDriver.Say(new
                {
                    claimed = new
                    {
                        jobId = job.JobId,
                        jobType = job.JobType,
                        resourceId = job.ResourceId,
                        @params = job.Params,
                        completedUnits = job.CompletedUnits,
                        unitCursors = job.UnitCursors,
                        retryCount = job.RetryCount,
                        maxRetries = job.MaxRetries,
                    },
                });
            }
        }
    }

    private static async Task ReportRefusalsAsync(Claims worker)
    {
        await foreach (var refusal in worker.Refused().ConfigureAwait(false))
            WireDriver.Say(new { refused = new { code = refusal.Code, detail = refusal.Detail } });
    }

    private static async Task ReportStallsAsync(Claims worker)
    {
        await foreach (var stall in worker.Stalled().ConfigureAwait(false)) WireDriver.Say(new { stalled = stall.JobId.Value });
    }

    private static async Task ReportStatesAsync(HttpTransport transport)
    {
        await foreach (var state in transport.States().ConfigureAwait(false)) WireDriver.Say(new { state = state.ToString().ToLowerInvariant() });
    }

    private static async Task ReportErrorsAsync(HttpTransport transport)
    {
        await foreach (var error in transport.Errors().ConfigureAwait(false))
            WireDriver.Say(new { error = new { code = error.Code, status = error.Status, detail = error.Message } });
    }

    private async Task SayForJobAsync(JsonElement args)
    {
        Held current;
        lock (gate) current = held ?? throw new InvalidOperationException("No job is held.");
        var job = current.Job;
        var previous = Activity.Current;
        Activity.Current = current.Span;
        try
        {
            switch (Text(args, "op"))
            {
                case "start": await job.StartAsync().ConfigureAwait(false); break;
                case "progress":
                    var message = args.TryGetProperty("message", out var progressMessage) ? progressMessage.Deserialize<JobProgressMessage>() : null;
                    await job.ProgressAsync(new JobProgress { Percentage = args.GetProperty("percentage").GetDouble(), Message = message }).ConfigureAwait(false);
                    break;
                case "checkpoint":
                    await job.CheckpointAsync(Required<string[]>(args, "completedUnits"),
                        Optional<Dictionary<string, UnitCursor>>(args, "unitCursors")).ConfigureAwait(false);
                    break;
                case "commit":
                    await job.CommitAsync(ResourceId.Parse(Text(args, "resourceId")), Required<Annotation[]>(args, "annotations")).ConfigureAwait(false);
                    break;
                case "complete":
                    if (job is HeldMarkJob mark) await mark.CompleteAsync(Required<MarkJobResult>(args, "result")).ConfigureAwait(false);
                    else if (job is HeldYieldJob yield) await yield.CompleteAsync(Required<YieldJobResult>(args, "result")).ConfigureAwait(false);
                    break;
                case "fail":
                    var kind = args.TryGetProperty("failureClass", out var failure) ? failure.Deserialize<FailureClass>() : (FailureClass?)null;
                    await job.FailAsync(Text(args, "error"), kind, Optional<string[]>(args, "completedUnits"),
                        Optional<Dictionary<string, UnitCursor>>(args, "unitCursors")).ConfigureAwait(false);
                    break;
                case "cancel":
                    await job.CancelAsync(Optional<string[]>(args, "completedUnits")).ConfigureAwait(false);
                    break;
                default: throw new InvalidOperationException("Unknown worker operation.");
            }
        }
        finally
        {
            Activity.Current = previous;
            if (job.Settled)
            {
                lock (gate)
                {
                    if (held == current)
                    {
                        current.Dispose();
                        held = null;
                    }
                }
            }
        }
    }

    // End of input kills the driver. Only an explicit close settles a held job.
    public void Dispose()
    {
        foreach (var scope in scopes) scope.Dispose();
        client?.Dispose();
        lock (gate)
        {
            held?.Dispose();
            held = null;
        }
    }

    private static string Text(JsonElement args, string name) => args.GetProperty(name).GetString() ?? throw new InvalidOperationException("Missing " + name);
    private static T Required<T>(JsonElement args, string name) where T : class =>
        args.GetProperty(name).Deserialize<T>() ?? throw new InvalidOperationException("Missing " + name);
    private static T? Optional<T>(JsonElement args, string name) where T : class =>
        args.TryGetProperty(name, out var value) ? value.Deserialize<T>() : null;

    private sealed record Held(IHeldJob Job, Activity? Span, CancellationTokenRegistration Cancellation) : IDisposable
    {
        public void Dispose()
        {
            Cancellation.Dispose();
            Span?.Dispose();
        }
    }
}
