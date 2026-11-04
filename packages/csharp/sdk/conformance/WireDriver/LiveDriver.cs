using System.Text.Json;
using System.Text.Json.Nodes;
using Semiont;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Types;

internal sealed class LiveDriver : IDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, Observation> observations = new(StringComparer.Ordinal);
    private SemiontClient? client;
    private string? saved;
    private ConnectionState? reported;

    private SemiontClient Client => client ?? throw new InvalidOperationException("No client is open");

    internal async Task RunAsync(JsonElement args)
    {
        var id = args.GetProperty("id").GetInt64();
        try
        {
            object? answer = null;
            switch (Text(args, "op"))
            {
                case "open": Open(args); break;
                case "close": Client.Dispose(); break;
                case "sync": if (client is { } active) Report(active, active.State); break;
                case "observe":
                    var observer = Text(args, "observer");
                    var query = QueryOf(args.GetProperty("query"));
                    await Begin(observer, query.ReadAsync).ConfigureAwait(false);
                    break;
                case "unobserve": Stop(Text(args, "observer")); break;
                case "fresh": answer = new { value = await QueryOf(args.GetProperty("query")).FreshAsync().ConfigureAwait(false) }; break;
                case "invalidate": QueryOf(args.GetProperty("query")).Invalidate(); break;
                case "delete":
                    await Client.Mark.DeleteAsync(ResourceId.Parse(Text(args, "resource")), AnnotationId.Parse(Text(args, "annotation"))).ConfigureAwait(false);
                    break;
                case "markDelegate":
                    var mark = Client.Mark.Delegate(ResourceId.Parse(Text(args, "resource")), Required<MarkJobParams>(args, "params"));
                    Follow(Text(args, "observer"), mark);
                    break;
                case "yieldDelegate":
                    var stall = args.TryGetProperty("stallDeadlineMs", out var deadline) ? deadline.GetInt32() : (int?)null;
                    var yield = Client.Yield.Delegate(Required<GenerationJobParams>(args, "params"), stall);
                    Follow(Text(args, "observer"), yield);
                    break;
                default: WireDriver.Say(new { id, unsupported = true }); return;
            }
            WireDriver.Say(new JsonObject { ["id"] = id, ["ok"] = JsonSerializer.SerializeToNode(answer) });
        }
        catch (SemiontError error) { WireDriver.Say(new { id, error = Failure(error) }); }
        catch (Exception error) { WireDriver.Say(new { id, misuse = error.Message }); }
    }

    private void Open(JsonElement args)
    {
        if (client is { State: not ConnectionState.Closed }) throw new InvalidOperationException("A client is already open");
        var persistence = args.TryGetProperty("persist", out var persist) && persist.GetBoolean()
            ? new CachePersistence(() => saved, value => saved = value) : null;
        var timing = args.TryGetProperty("timing", out var values)
            ? values.Deserialize<Timing>(new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) : null;
        var opened = new SemiontClient(Text(args, "baseUrl"), Text(args, "token"), timing: timing, persistence: persistence);
        lock (gate)
        {
            reported = null;
            client = opened;
        }
        _ = ReportStatesAsync(opened);
        _ = ReportErrorsAsync(opened);
    }

    private async Task ReportStatesAsync(SemiontClient opened)
    {
        await foreach (var state in opened.Transport.States().ConfigureAwait(false)) Report(opened, state);
    }

    private void Report(SemiontClient opened, ConnectionState state)
    {
        lock (gate)
        {
            if (opened != client || state == reported) return;
            reported = state;
            WireDriver.Say(new { state = state.ToString().ToLowerInvariant() });
        }
    }

    private static async Task ReportErrorsAsync(SemiontClient opened)
    {
        await foreach (var error in opened.Transport.Errors().ConfigureAwait(false)) WireDriver.Say(new { error = Failure(error) });
    }

    private Task Begin(string name, Func<string, TaskCompletionSource, CancellationToken, Task> work)
    {
        var observation = new Observation();
        lock (gate)
        {
            if (!observations.TryAdd(name, observation))
            {
                observation.Cancellation.Dispose();
                throw new InvalidOperationException("Observer already exists: " + name);
            }
        }
        var first = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _ = RunObservationAsync();
        return first.Task;

        async Task RunObservationAsync()
        {
            try { await work(name, first, observation.Cancellation.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) when (observation.Cancellation.IsCancellationRequested) { }
            catch (Exception error) { Emit(name, new { status = "failed", error = Failure(error) }); }
            finally
            {
                lock (gate)
                {
                    observations.Remove(name);
                    if (!observation.Cancellation.IsCancellationRequested) WireDriver.Say(new { completed = name });
                    observation.Cancellation.Dispose();
                }
                first.TrySetResult();
            }
        }
    }

    private void Stop(string name)
    {
        lock (gate)
        {
            if (!observations.TryGetValue(name, out var observation)) throw new InvalidOperationException("No observer named " + name);
            observation.Cancellation.Cancel();
        }
    }

    private void Follow<T>(string name, Delegation<T> delegation) =>
        _ = Begin(name, async (observer, first, cancellation) =>
        {
            first.TrySetResult();
            await foreach (var update in delegation.WithCancellation(cancellation).ConfigureAwait(false))
            {
                var value = update switch
                {
                    JobEvent<T>.Created(var data) => Event("created", data),
                    JobEvent<T>.Progress(var data) => Event("progress", data),
                    JobEvent<T>.Failed(var data) => Event("failed", data),
                    JobEvent<T>.Complete(var data) => Event("complete", data),
                };
                Emit(observer, new { status = "ready", value });
            }
        });

    private IQuery QueryOf(JsonElement args)
    {
        ResourceId Resource() => ResourceId.Parse(Text(args, "resource"));
        var filters = args.TryGetProperty("filters", out var stated) ? stated : JsonSerializer.SerializeToElement(new { });
        var limit = filters.TryGetProperty("limit", out var l) ? l.GetInt64() : 100;
        var offset = filters.TryGetProperty("offset", out var o) ? o.GetInt64() : 0;
        var archived = filters.TryGetProperty("archived", out var a) ? a.GetBoolean() : (bool?)null;
        var entityType = filters.TryGetProperty("entityType", out var e) ? e.GetString() : null;
        return Text(args, "query") switch
        {
            "resource" => Query(Client.Browse.Resource(Resource())),
            "resources" => Query(Client.Browse.Resources(limit, offset, archived, entityType)),
            "annotations" => Query(Client.Browse.Annotations(Resource())),
            "annotation" => Query(Client.Browse.Annotation(Resource(), AnnotationId.Parse(Text(args, "annotation")))),
            "events" => Query(Client.Browse.Events(Resource())),
            "referencedBy" => Query(Client.Gather.ReferencedBy(Resource())),
            "matchedResources" => Query(Client.Match.Resources(Text(args, "search"), limit, offset, archived, entityType)),
            "entityTypes" => Query(Client.Browse.EntityTypes()),
            "tagSchemas" => Query(Client.Browse.TagSchemas()),
            "engines" => Query(Client.Browse.Engines(), Engines),
            var name => throw new InvalidOperationException("Unknown query " + name),
        };
    }

    private static JsonElement Engines(IReadOnlyList<EngineWithLimits> engines) => JsonSerializer.SerializeToElement(engines.Select(engine =>
    {
        var node = JsonSerializer.SerializeToNode(engine.Entry)?.AsObject() ?? throw new InvalidOperationException("Missing engine");
        if (engine.Limits is { } limits) node["limits"] = JsonSerializer.SerializeToNode(limits);
        return node;
    }));

    private static IQuery Query<T>(Cached<T> cached, Func<T, JsonElement>? encode = null) =>
        new QueryView<T>(cached, encode ?? (value => JsonSerializer.SerializeToElement(value)));

    private static string Text(JsonElement row, string key) => row.GetProperty(key).GetString() ?? throw new InvalidOperationException("Missing " + key);
    private static T Required<T>(JsonElement row, string key) where T : class =>
        row.GetProperty(key).Deserialize<T>() ?? throw new InvalidOperationException("Missing " + key);
    private static object Failure(Exception error)
    {
        var failure = new JsonObject { ["detail"] = error.Message };
        if (error is SemiontError semiont) failure["code"] = semiont.Code;
        if (error is JobError { FailureClass: { } kind }) failure["failureClass"] = JsonSerializer.SerializeToNode(kind);
        if (error is TransportError { Status: { } status }) failure["status"] = status;
        return failure;
    }
    private static object Event<T>(string kind, T data) => new { kind, data };
    private static void Emit(string observer, object state) => WireDriver.Say(new { emission = new { observer, state } });

    public void Dispose() => client?.Dispose();

    private sealed class Observation
    {
        internal CancellationTokenSource Cancellation { get; } = new();
    }

    private interface IQuery
    {
        public Task ReadAsync(string observer, TaskCompletionSource first, CancellationToken cancellation);
        public Task<JsonElement> FreshAsync();
        public void Invalidate();
    }

    private sealed class QueryView<T>(Cached<T> cached, Func<T, JsonElement> encode) : IQuery
    {
        public async Task ReadAsync(string observer, TaskCompletionSource first, CancellationToken cancellation)
        {
            await foreach (var state in cached.WithCancellation(cancellation).ConfigureAwait(false))
            {
                object payload = state switch
                {
                    CacheState<T>.Pending => new { status = "pending" },
                    CacheState<T>.Ready(var value) => new { status = "ready", value = encode(value) },
                    CacheState<T>.Failed(var error) => new { status = "failed", error = Failure(error) },
                };
                Emit(observer, payload);
                first.TrySetResult();
            }
        }

        public async Task<JsonElement> FreshAsync() => encode(await cached.FreshAsync().ConfigureAwait(false));
        public void Invalidate() => cached.Invalidate();
    }
}
