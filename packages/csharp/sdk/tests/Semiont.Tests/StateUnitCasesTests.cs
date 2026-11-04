using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.State;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed partial class TransportTests
{
    private const string StateTable = "client/state-units.json";
    private static readonly JsonSerializerOptions StateJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static IEnumerable<object[]> StateUnitCases()
    {
        using var table = ReadSpec(StateTable);
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
            yield return [Text(row, "unit"), Text(row, "case")];
    }

    [Theory]
    [MemberData(nameof(StateUnitCases))]
    public async Task RunsTheSharedStateUnitCase(string unit, string name)
    {
        using var table = ReadSpec(StateTable);
        var fixtures = table.RootElement.GetProperty("fixtures");
        var row = table.RootElement.GetProperty("cases").EnumerateArray().Single(row => Text(row, "unit") == unit && Text(row, "case") == name);
        using var player = new StateCasePlayer(row, fixtures);
        await player.RunAsync();
    }

    [Fact]
    public async Task EqualSessionNoticesAreEachObservedAndNullReplays()
    {
        using var signals = new SessionSignals();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var reader = signals.PermissionDenied.GetAsyncEnumerator(deadline.Token);
        Assert.True(await reader.MoveNextAsync());
        Assert.Null(reader.Current);
        signals.NotifyPermissionDenied(null);
        signals.NotifyPermissionDenied(null);
        for (var occurrence = 0; occurrence < 2; occurrence++)
        {
            Assert.True(await reader.MoveNextAsync());
            Assert.Equal(new PermissionDenied(null), reader.Current);
        }
        signals.Dispose();
        Assert.False(await reader.MoveNextAsync());
    }

    private sealed class StateCasePlayer : IDisposable
    {
        private readonly JsonElement row;
        private readonly JsonElement fixtures;
        private readonly StateCaseClock clock = new();
        private readonly Handler gateway = new();
        private readonly HttpClient http;
        private readonly SemiontClient client;
        private readonly ConcurrentQueue<JsonElement> requests = new();
        private readonly ConcurrentQueue<JsonElement> unanswered = new();
        private readonly ConcurrentDictionary<string, ConcurrentQueue<JsonElement>> replies = new(StringComparer.Ordinal);
        private readonly ConcurrentQueue<(string Query, Channel<IReadOnlyList<string>?> Answers)> searches = new();
        private readonly Dictionary<string, IStateUnit> units = new(StringComparer.Ordinal);
        private readonly EventBus.Subscription listening;
        private readonly CancellationTokenSource deadline = new(TimeSpan.FromSeconds(25));
        private readonly string answers;
        private readonly TimeSpan delay;

        internal StateCasePlayer(JsonElement row, JsonElement fixtures)
        {
            this.row = row;
            this.fixtures = fixtures;
            var transport = row.GetProperty("transport");
            answers = Text(transport, "answers");
            delay = transport.TryGetProperty("delayMs", out var wait) ? Duration(wait) : TimeSpan.Zero;
            if (transport.TryGetProperty("replies", out var queued))
                foreach (var operation in queued.EnumerateObject())
                    foreach (var response in operation.Value.EnumerateArray()) QueueReply(operation.Name, Resolve(response));
            gateway.Answer = request =>
            {
                requests.Enqueue(request);
                unanswered.Enqueue(request);
            };
            http = new HttpClient(gateway);
            client = new SemiontClient("http://unit.test", "token", http, timeProvider: clock);
            listening = client.Bus.Listen(row.TryGetProperty("listen", out var channels)
                ? channels.EnumerateArray().Select(TextValue).ToArray() : []);
        }

        internal async Task RunAsync()
        {
            await OpenAsync(client.Transport);
            foreach (var item in row.GetProperty("made").EnumerateObject())
                units.Add(item.Name, Make(Text(row, "unit"), item.Value));
            var index = 0;
            foreach (var step in row.GetProperty("steps").EnumerateArray())
            {
                try { await StepAsync(step); }
                catch (Exception error) { throw new InvalidOperationException($"Step {index} {step}", error); }
                index++;
            }
        }

        private IStateUnit Make(string name, JsonElement options) => name switch
        {
            "match" => new MatchStateUnit(client),
            "beckon" => new BeckonStateUnit(client, Read<ResourceId>(options, "resourceId")),
            "hoverDwell" => new HoverDwell(client.Beckon.Hover, Duration(options.GetProperty("delayMs")), clock),
            "search" => new SearchPipeline<string>(Search, options.TryGetProperty("debounceMs", out var debounce) ? Duration(debounce) : null,
                options.TryGetProperty("initialQuery", out var query) ? TextValue(query) : "", clock),
            "gather" => new GatherStateUnit(client, Read<ResourceId>(options, "resourceId")),
            "yield" => new YieldStateUnit(client, Text(options, "locale")),
            "mark" => new MarkStateUnit(client, Read<ResourceId>(options, "resourceId")),
            "sessionSignals" => new SessionSignals(),
            _ => throw new InvalidOperationException("Unknown unit " + name),
        };

        private IAsyncEnumerable<IReadOnlyList<string>?> Search(string query, CancellationToken cancellation)
        {
            var channel = Channel.CreateUnbounded<IReadOnlyList<string>?>();
            searches.Enqueue((query, channel));
            return channel.Reader.ReadAllAsync(cancellation);
        }

        private void QueueReply(string operation, JsonElement response) =>
            replies.GetOrAdd(operation, _ => new ConcurrentQueue<JsonElement>()).Enqueue(response);

        private async Task AnswerAsync(JsonElement request)
        {
            if (delay != TimeSpan.Zero) await Task.Delay(delay, clock, deadline.Token);
            var name = Text(request, "channel");
            var operation = ProtocolFacts.Operation(name);
            if (replies.TryGetValue(name, out var queued) && queued.TryDequeue(out var response))
            {
                if (response.ValueKind != JsonValueKind.Null) Reply(gateway, request, operation.Result, new { response });
                return;
            }
            if (answers == "never") return;
            if (answers == "jobs" && name == BusOperations.JobCreate.Request.Name)
            {
                Reply(gateway, request, operation.Result, new { response = new { jobId = "job-1" } });
                return;
            }
            if (answers == "jobs" && name == BusOperations.JobStatusRequested.Request.Name)
            {
                Reply(gateway, request, operation.Result,
                    new { response = new { jobId = "job-1", type = "mark", status = "running", userId = "did:web:example.org:users:alice", created = "2026-10-01T00:00:00.000Z" } });
                return;
            }
            Reply(gateway, request, operation.Failure, new { message = "Unscripted " + name });
        }

        private async Task StepAsync(JsonElement step)
        {
            if (step.ValueKind == JsonValueKind.String && TextValue(step) == "settle") { await SettleAsync(); return; }
            var action = step.EnumerateObject().First();
            var correlation = step.TryGetProperty("correlationId", out var id) ? id.GetString() : null;
            switch (action.Name)
            {
                case "say":
                case "deliver":
                    var frame = new BusFrame { Channel = TextValue(action.Value), Payload = Resolve(step.GetProperty("payload")), CorrelationId = correlation };
                    if (action.Name == "say") client.Bus.Receive(new ReceivedBusFrame(frame, default));
                    else gateway.Stream.Push("event: bus-event\ndata: " + JsonSerializer.Serialize(frame) + "\n\n");
                    break;
                case "answer":
                    var request = Request(TextValue(action.Value), step.GetProperty("nth").GetInt32());
                    Reply(gateway, request, Text(step, "reply"), Resolve(step.GetProperty("payload")));
                    break;
                case "queueReply": QueueReply(TextValue(action.Value), Resolve(step.GetProperty("response"))); break;
                case "invoke":
                    Invoke(units[Text(step, "of")], TextValue(action.Value),
                        step.TryGetProperty("args", out var args) ? Resolve(args) : JsonSerializer.SerializeToElement(new { }));
                    break;
                case "pass":
                    await SettleAsync();
                    var target = clock.GetTimestamp() + Duration(action.Value).Ticks;
                    while (clock.FireNext(target)) await SettleAsync();
                    await SettleAsync();
                    break;
                case "dispose": units[TextValue(action.Value)].Dispose(); break;
                case "answerSearch":
                    var results = step.GetProperty("results").Deserialize<string[]>();
                    Assert.True(searches.ToArray()[action.Value.GetInt32()].Answers.Writer.TryWrite(results));
                    break;
                case "searched": Assert.Equal(action.Value.EnumerateArray().Select(TextValue), searches.Select(search => search.Query)); break;
                case "expect":
                    foreach (var subject in action.Value.EnumerateObject())
                        foreach (var member in subject.Value.EnumerateObject())
                            CheckValue(Resolve(member.Value), ValueOf(Watch(units[subject.Name], member.Name)), $"{subject.Name}.{member.Name}");
                    break;
                case "sent":
                    var payloads = requests.Where(request => Text(request, "channel") == TextValue(action.Value))
                        .Select(request => request.GetProperty("payload")).ToArray();
                    if (step.TryGetProperty("count", out var count)) Assert.Equal(count.GetInt32(), payloads.Length);
                    else CheckValue(Resolve(step.GetProperty("payloads")), payloads, "sent payloads");
                    break;
                case "nothingSent": Assert.Empty(requests); break;
                case "heard":
                    await SettleAsync();
                    var seen = new List<BusFrame>();
                    while (listening.Reader.TryRead(out var received)) seen.Add(received.Frame);
                    var wanted = action.Value.EnumerateArray().ToArray();
                    Assert.True(seen.Count == wanted.Length, "Heard " + JsonSerializer.Serialize(seen));
                    foreach (var (expected, actual) in wanted.Zip(seen))
                    {
                        Assert.Equal(Text(expected, "channel"), actual.Channel);
                        CheckValue(Resolve(expected.GetProperty("payload")), actual.Payload, "heard payload");
                        string? expectedId = null;
                        if (expected.TryGetProperty("correlationId", out var expectedCorrelation))
                            expectedId = expectedCorrelation.ValueKind == JsonValueKind.Object
                                ? Text(Request(Text(expectedCorrelation, "sent"), expectedCorrelation.GetProperty("nth").GetInt32()), "correlationId")
                                : expectedCorrelation.GetString();
                        Assert.Equal(expectedId, actual.CorrelationId);
                    }
                    break;
                case "ended":
                    foreach (var subject in action.Value.EnumerateObject())
                        foreach (var member in subject.Value.EnumerateArray())
                            await EndedAsync(Watch(units[subject.Name], TextValue(member)));
                    break;
                case "busDestroyed":
                    using (var probe = client.Bus.Listen([])) Assert.Equal(action.Value.GetBoolean(), probe.Reader.Completion.IsCompleted);
                    break;
                default: throw new InvalidOperationException("Unknown step " + action.Name);
            }
        }

        private async Task SettleAsync()
        {
            // Only settled steps release gateway answers. An immediate expect can inspect the
            // state set by an invocation before its wire response is available.
            for (var idle = 0; idle < 2;)
            {
                if (unanswered.TryDequeue(out var request))
                {
                    _ = AnswerAsync(request);
                    idle = 0;
                    continue;
                }
                await Task.Delay(4, deadline.Token);
                idle = unanswered.IsEmpty ? idle + 1 : 0;
            }
        }

        private JsonElement Request(string name, int nth) =>
            requests.Where(request => Text(request, "channel") == name).ElementAt(nth);

        private async Task EndedAsync(object watch)
        {
            var type = watch.GetType().GetGenericArguments().Single();
            var method = typeof(StateCasePlayer).GetMethod(nameof(DrainAsync), System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)
                ?? throw new InvalidOperationException("Missing reader probe.");
            using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(1));
            var draining = Assert.IsAssignableFrom<Task>(method.MakeGenericMethod(type).Invoke(null, [watch, wait.Token]));
            await draining;
        }

        private static async Task DrainAsync<T>(StateValue<T> watch, CancellationToken cancellation)
        {
            await foreach (var _ in watch.WithCancellation(cancellation)) { }
        }

        private static object Watch(IStateUnit unit, string member) =>
            unit.GetType().GetProperty(char.ToUpperInvariant(member[0]) + member[1..])?.GetValue(unit)
            ?? throw new InvalidOperationException("Unknown observable " + member);

        private static object? ValueOf(object watch) =>
            (watch.GetType().GetProperty("Value") ?? throw new InvalidOperationException("No current value.")).GetValue(watch);

        private static void Invoke(IStateUnit unit, string method, JsonElement args)
        {
            switch (unit, method)
            {
                case (BeckonStateUnit one, "focus"): one.Focus(Read<AnnotationId>(args, "annotationId")); break;
                case (HoverDwell one, "enter"): one.Enter(Read<AnnotationId>(args, "annotationId")); break;
                case (HoverDwell one, "leave"): one.Leave(); break;
                case (SearchPipeline<string> one, "setQuery"): one.SetQuery(Text(args, "value")); break;
                case (GatherStateUnit one, "gatherAnnotation"):
                    one.GatherAnnotation(Read<AnnotationId>(args, "annotationId"),
                    new GatherAnnotationOptions
                    {
                        ContextWindow = args.TryGetProperty("contextWindow", out var window) ? window.GetInt64() : null,
                        IncludeSourceContext = args.TryGetProperty("includeSourceContext", out var source) ? source.GetBoolean() : null,
                        IncludeTargetContext = args.TryGetProperty("includeTargetContext", out var target) ? target.GetBoolean() : null,
                    }); break;
                case (GatherStateUnit one, "gatherResource"): one.GatherResource(Read<ResourceId>(args, "resourceId")); break;
                case (YieldStateUnit one, "generate"):
                    one.Generate(Read<GenerationJobParams>(args, "params"),
                    args.TryGetProperty("stallDeadlineMs", out var stall) ? (int)Duration(stall).TotalMilliseconds : null); break;
                case (YieldStateUnit one, "dismissProgress"): one.DismissProgress(); break;
                case (MarkStateUnit one, "requestDelegate"): one.RequestDelegate(Read<MarkJobParams>(args, "params")); break;
                case (MarkStateUnit one, "cancelPending"): one.CancelPending(); break;
                case (MarkStateUnit one, "dismissProgress"): one.DismissProgress(); break;
                case (SessionSignals one, "notifySessionEnded"): one.NotifySessionEnded(Text(args, "reason")); break;
                case (SessionSignals one, "notifyPermissionDenied"): one.NotifyPermissionDenied(args.GetProperty("detail").GetString()); break;
                case (SessionSignals one, "notifyKbIdentityConflict"): one.NotifyKbIdentityConflict(Read<KbIdentityConflict>(args, "conflict")); break;
                case (SessionSignals one, "acknowledgeSessionEnded"): one.AcknowledgeSessionEnded(); break;
                case (SessionSignals one, "acknowledgePermissionDenied"): one.AcknowledgePermissionDenied(); break;
                case (SessionSignals one, "acknowledgeKbIdentityConflict"): one.AcknowledgeKbIdentityConflict(); break;
                default: throw new InvalidOperationException("Unknown invocation " + method);
            }
        }

        private JsonElement Resolve(JsonElement value)
        {
            if (value.ValueKind == JsonValueKind.Array) return JsonSerializer.SerializeToElement(value.EnumerateArray().Select(Resolve));
            if (value.ValueKind != JsonValueKind.Object) return value;
            if (value.TryGetProperty("$fixture", out var fixture)) return Resolve(fixtures.GetProperty(TextValue(fixture)));
            return JsonSerializer.SerializeToElement(value.EnumerateObject().ToDictionary(field => field.Name, field => Resolve(field.Value)));
        }

        private static TimeSpan Duration(JsonElement duration)
        {
            if (duration.ValueKind == JsonValueKind.Number) return TimeSpan.FromMilliseconds(duration.GetInt64());
            var basis = ProtocolFacts.Timing(Text(duration, "timing")).GetDouble();
            var scale = duration.TryGetProperty("times", out var times) ? times.GetDouble() : 1;
            var extra = duration.TryGetProperty("plusMs", out var plus) ? plus.GetDouble() : 0;
            return TimeSpan.FromMilliseconds(Math.Round(basis * scale, MidpointRounding.AwayFromZero) + extra);
        }

        private static void CheckValue(JsonElement expected, object? value, string label)
        {
            var actual = value is SemiontError error
                ? JsonSerializer.SerializeToElement(new { code = error.Code, message = error.Message })
                : JsonSerializer.SerializeToElement(value, StateJson);
            var matched = value is SemiontError ? Subset(expected, actual) : Matches(expected, actual);
            Assert.True(matched, $"{label} holds {actual}, expected {expected}");
        }

        private static bool Matches(JsonElement expected, JsonElement actual)
        {
            if (expected.ValueKind == JsonValueKind.Object && expected.TryGetProperty("$has", out var subset))
                return Subset(subset, actual);
            if (expected.ValueKind == JsonValueKind.Object)
                return actual.ValueKind == JsonValueKind.Object && expected.EnumerateObject().Count() == actual.EnumerateObject().Count() && Subset(expected, actual);
            if (expected.ValueKind == JsonValueKind.Array)
                return actual.ValueKind == JsonValueKind.Array && expected.GetArrayLength() == actual.GetArrayLength() &&
                    expected.EnumerateArray().Zip(actual.EnumerateArray()).All(pair => Matches(pair.First, pair.Second));
            return JsonElement.DeepEquals(expected, actual);
        }

        private static bool Subset(JsonElement expected, JsonElement actual) =>
            expected.ValueKind == JsonValueKind.Object && actual.ValueKind == JsonValueKind.Object &&
            expected.EnumerateObject().All(field => actual.TryGetProperty(field.Name, out var value) && Matches(field.Value, value));

        private static T Read<T>(JsonElement row, string name) => row.GetProperty(name).Deserialize<T>(StateJson)
            ?? throw new InvalidOperationException("Missing " + name);

        private static string TextValue(JsonElement value) => value.GetString() ?? throw new InvalidOperationException("Missing string value.");

        public void Dispose()
        {
            foreach (var unit in units.Values) unit.Dispose();
            listening.Dispose();
            client.Dispose();
            http.Dispose();
            deadline.Cancel();
            deadline.Dispose();
        }
    }
}
