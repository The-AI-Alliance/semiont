using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Semiont.Discovery;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Jobs;
using Semiont.Protocol;
using Semiont.Session;
using Semiont.SignIn;
using Semiont.Testing;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

/// <summary>
/// The time a client keeps, against protocol/specs/src/client/clock-cases.json. Each case builds its subject over a
/// network faked in this process, on a <see cref="StateCaseClock"/> that moves only when the case moves it, at this
/// SDK's timings, which are the table's, and with <see cref="ZeroRandom"/>, the lowest draw a source can give. A pass
/// stops the clock at each instant a timer falls due, in turn, and lets what falls due run there, so a wait ends at
/// the instant it was set to end, or the case fails. The clock is not FakeTimeProvider: it tells no one when its next
/// timer falls due, so a pass could stop at each such instant only by moving a millisecond at a time.
/// </summary>
public sealed class ClockCasesTests
{
    private const string Table = "client/clock-cases.json";
    private const string GatewayUrl = "http://gateway.test";
    private const string IssuerUrl = "http://issuer.test/realms/semiont";
    private const string Subscribe = "/bus/subscribe";
    private const string Emit = "/bus/emit";
    private const string Health = "/api/health";
    private static readonly DateTimeOffset Began = DateTimeOffset.FromUnixTimeSeconds(2000000000);
    private static readonly ResourceId Resource = ResourceId.Parse("res-1");

    /// <summary>How long, on the machine's own time, a piece of work that is to end without the clock moving is given to end in.</summary>
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    /// <summary>How long, on the machine's own time, one case may run.</summary>
    private static readonly TimeSpan CaseLimit = TimeSpan.FromSeconds(60);

    /// <summary>How long, on the machine's own time, a settle waits between its looks at what has changed.</summary>
    private static readonly TimeSpan Look = TimeSpan.FromMilliseconds(5);

    /// <summary>How many looks in a row a settle sees nothing change in before it is settled.</summary>
    private const int QuietLooks = 4;

    private static readonly IReadOnlyDictionary<string, Build> Subjects = new Dictionary<string, Build>(StringComparer.Ordinal)
    {
        ["refusedStream"] = RefusedStreamAsync,
        ["unansweredStream"] = UnansweredStreamAsync,
        ["degradedStream"] = DegradedStreamAsync,
        ["scopeTaken"] = ScopeTakenAsync,
        ["scopeLetGo"] = ScopeLetGoAsync,
        ["handoffLinger"] = HandoffLingerAsync,
        ["renewal"] = RenewalAsync,
        ["deviceGrant"] = DeviceGrantAsync,
        ["heldJobStall"] = HeldJobStallAsync,
        ["discovery"] = DiscoveryAsync,
        ["invalidationWindow"] = InvalidationWindowAsync,
        ["saveDebounce"] = SaveDebounceAsync,
        ["jobFollower"] = JobFollowerAsync,
        ["unansweredRequest"] = UnansweredRequestAsync,
        ["unansweredEmit"] = UnansweredEmitAsync,
    };

    public static IEnumerable<object[]> Cases()
    {
        using var table = ReadTable();
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray())
            yield return [Text(row, "subject"), Text(row, "case")];
    }

    [Fact]
    public void ThisRunnerBuildsEverySubjectTheTableNamesAndNoOther()
    {
        using var table = ReadTable();
        var named = table.RootElement.GetProperty("cases").EnumerateArray().Select(row => Text(row, "subject")).Distinct();
        Assert.Equal(named.Order(StringComparer.Ordinal), Subjects.Keys.Order(StringComparer.Ordinal));
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public async Task AWaitEndsWhenItsCaseSays(string subject, string name)
    {
        using var table = ReadTable();
        await PlayAsync(table.RootElement.GetProperty("cases").EnumerateArray()
            .Single(row => Text(row, "subject") == subject && Text(row, "case") == name));
    }

    [Fact]
    public async Task TheRunnerFailsACaseWhoseWaitEndsAMillisecondEarly()
    {
        using var table = ReadTable();
        var told = JsonNode.Parse(table.RootElement.GetProperty("cases").EnumerateArray()
            .First(row => Text(row, "subject") == "refusedStream").GetRawText()) ?? throw new InvalidOperationException("A case is null");
        var steps = told["steps"]?.AsArray() ?? throw new InvalidOperationException("A case has no steps");
        // The last millisecond of the first wait: the case is told the stream was opened again in it.
        Assert.Equal("""{"counted":1}""", steps[2]?.ToJsonString());
        steps[2] = JsonNode.Parse("""{"counted":2}""");
        var failure = await Assert.ThrowsAsync<CaseFailed>(() => PlayAsync(JsonSerializer.SerializeToElement(told)));
        Assert.StartsWith("steps[2] ", failure.Message, StringComparison.Ordinal);
    }

    private static async Task PlayAsync(JsonElement row)
    {
        var given = row.TryGetProperty("given", out var stated) ? stated : JsonSerializer.SerializeToElement(new { });
        await using var play = new Case();
        var subject = await Case.AtOnceAsync(Subjects[Text(row, "subject")](given, play));
        play.Counts(subject.Counted);
        var at = 0;
        foreach (var step in row.GetProperty("steps").EnumerateArray())
        {
            try { await play.PerformAsync(step, subject); }
            catch (CaseFailed broken) { throw new CaseFailed($"steps[{at}] {step.GetRawText()}, at {play.AtMs} ms: {broken.Message}"); }
            at++;
        }
    }

    private static JsonDocument ReadTable() =>
        JsonDocument.Parse(File.ReadAllText(Path.Join(AppContext.BaseDirectory, "specs", Table)));

    private static string Text(JsonElement row, string name) =>
        row.GetProperty(name).GetString() ?? throw new InvalidOperationException("Missing " + name);

    /// <summary>A duration as the table states it, in milliseconds: a whole number of them.</summary>
    private static long DurationMs(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Number) return value.GetInt64();
        var times = value.TryGetProperty("times", out var scale) ? scale.GetDouble() : 1;
        var plus = value.TryGetProperty("plusMs", out var moved) ? moved.GetInt64() : 0;
        var scaled = TimingMs(Text(value, "timing")) * times + plus;
        if (!double.IsInteger(scaled)) throw new CaseFailed($"{value.GetRawText()} is not a whole number of milliseconds");
        return (long)scaled;
    }

    /// <summary>A duration protocol/specs/src/client/timing.json names, as this SDK reads it. A retry budget's member follows its budget and a `.`.</summary>
    private static double TimingMs(string name) => name.Split('.') switch
    {
        [var single] => ProtocolFacts.Timing(single).GetDouble(),
        [var budget, var member] => ProtocolFacts.Timing(budget).GetProperty(member).GetDouble(),
        _ => throw new CaseFailed($"{name} is no duration of this SDK's timing"),
    };

    private static int? GivenSeconds(JsonElement given, string name) =>
        given.TryGetProperty(name, out var value) ? value.GetInt32() : null;

    private static JsonElement Parsed(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    private static T Read<T>(string json) where T : class =>
        JsonSerializer.Deserialize<T>(json) ?? throw new InvalidOperationException("A fixture is null");

    private static CaseFailed Unscripted(string operation) =>
        new($"the gateway was asked {operation}, which this subject does not have it answer");

    private static int Sent(FaultyTransport transport, string operation) =>
        transport.RequestLog.Count(entry => entry.Operation == operation);

    // ── The gateway ─────────────────────────────────────────────────────────

    private static HttpTransport Over(Gateway gateway, Case play)
    {
        var http = play.Keep(new HttpClient(gateway) { Timeout = Timeout.InfiniteTimeSpan });
        return play.Keep(new HttpTransport(GatewayUrl, "a-token", BusRegistry.FullClientChannels, httpClient: http,
            timeProvider: play.Clock, random: play.Random));
    }

    private static Task<Subject> RefusedStreamAsync(JsonElement given, Case play)
    {
        var gateway = new Gateway(StreamAnswer.Refuses, GivenSeconds(given, "retryAfterSeconds"));
        Over(gateway, play);
        return Task.FromResult(new Subject(() => gateway.Asked(Subscribe), null));
    }

    private static Task<Subject> UnansweredStreamAsync(JsonElement given, Case play)
    {
        var gateway = new Gateway(StreamAnswer.Never, null);
        Over(gateway, play);
        return Task.FromResult(new Subject(() => gateway.Asked(Subscribe), null));
    }

    private static Task<Subject> DegradedStreamAsync(JsonElement given, Case play)
    {
        var transport = Over(new Gateway(StreamAnswer.Refuses, GivenSeconds(given, "retryAfterSeconds")), play);
        var degraded = 0;
        play.Running(async stop =>
        {
            await foreach (var state in transport.States(stop))
                if (state == ConnectionState.Degraded) Interlocked.Increment(ref degraded);
        });
        return Task.FromResult(new Subject(() => Volatile.Read(ref degraded), null));
    }

    private static Task<Subject> ScopeTakenAsync(JsonElement given, Case play)
    {
        var gateway = new Gateway(StreamAnswer.Holds, null);
        var transport = Over(gateway, play);
        return Task.FromResult(new Subject(() => gateway.Asked(Subscribe), () =>
        {
            play.Keep(transport.SubscribeToResource(Resource));
            return Task.CompletedTask;
        }));
    }

    private static async Task<Subject> ScopeLetGoAsync(JsonElement given, Case play)
    {
        var gateway = new Gateway(StreamAnswer.Holds, null);
        var transport = Over(gateway, play);
        await play.SettleAsync();
        if (transport.State != ConnectionState.Open) throw new CaseFailed($"the stream is {transport.State}, not open");
        var hold = transport.SubscribeToResource(Resource);
        return new Subject(() => gateway.Asked(Subscribe), () =>
        {
            hold.Dispose();
            return Task.CompletedTask;
        });
    }

    private static Task<Subject> HandoffLingerAsync(JsonElement given, Case play)
    {
        var gateway = new Gateway(StreamAnswer.Holds, null);
        var transport = Over(gateway, play);
        return Task.FromResult(new Subject(() => gateway.Closed, () =>
        {
            play.Keep(transport.SubscribeToResource(Resource));
            return Task.CompletedTask;
        }));
    }

    private static Task<Subject> UnansweredRequestAsync(JsonElement given, Case play)
    {
        var transport = Over(new Gateway(StreamAnswer.Holds, null, Health), play);
        var asked = play.Running(transport.HealthCheckAsync);
        return Task.FromResult(new Subject(() =>
        {
            if (!asked.IsCompleted) return 0;
            if (asked.Exception?.InnerException is TransportError { Status: null }) return 1;
            throw new CaseFailed($"the health check ended otherwise: {asked.Status}, {asked.Exception?.InnerException?.Message}");
        }, null));
    }

    private static Task<Subject> UnansweredEmitAsync(JsonElement given, Case play)
    {
        var gateway = new Gateway(StreamAnswer.Holds, null, Emit);
        var transport = Over(gateway, play);
        play.Running(stop => transport.EmitAsync("beckon:hover", Parsed("""{"annotationId":"ann-1"}"""), cancellation: stop));
        return Task.FromResult(new Subject(() => gateway.Asked(Emit), null));
    }

    // ── The issuer ──────────────────────────────────────────────────────────

    private static Task<Subject> DeviceGrantAsync(JsonElement given, Case play)
    {
        var answers = given.GetProperty("answers").EnumerateArray().Select(answer => answer.GetString()
            ?? throw new InvalidOperationException("An answer is null")).ToArray();
        var issuer = new DeviceIssuer(GivenSeconds(given, "intervalSeconds"), answers);
        var http = play.Keep(new HttpClient(issuer) { Timeout = Timeout.InfiniteTimeSpan });
        var signIn = play.Keep(new Issuer(http, play.Clock, play.Random));
        var endpoint = Read<HttpEndpoint>("""{"kind":"http","host":"gateway.test","port":80,"protocol":"http"}""");
        play.Running(stop => signIn.SignInDeviceAsync(endpoint, new MemorySignIn(), _ => { }, stop));
        return Task.FromResult(new Subject(() => issuer.TokenAsks, null));
    }

    // ── A session ───────────────────────────────────────────────────────────

    private static async Task<Subject> RenewalAsync(JsonElement given, Case play)
    {
        var lifetime = GivenSeconds(given, "lifetimeSeconds") ?? throw new CaseFailed("a renewal's case states how long its tokens live");
        var renewals = 0;
        string Issued()
        {
            var now = play.Clock.GetUtcNow().ToUnixTimeSeconds();
            return TokenTests.Jwt(new { iat = now, exp = now + lifetime });
        }
        var kept = new MemorySignIn(new StoredSession
        {
            Access = Issued(),
            Refresh = "a-refresh-token",
            ClientId = SignInPolicy.ScriptClientId,
            TokenEndpoint = IssuerUrl + "/token",
        });
        var alice = Read<UserResponse>("""{"did":"did:web:example.org:users:alice","domain":"example.org","email":null,"name":null,"image":null}""");
        var session = play.Keep(new KeptSession(kept, (_, _) =>
        {
            Interlocked.Increment(ref renewals);
            return Task.FromResult<string?>(Issued());
        }, (_, _) => Task.FromResult(alice), play.Clock, play.Random));
        await session.ReadyAsync();
        return new Subject(() => Volatile.Read(ref renewals), null);
    }

    // ── A worker's claims ───────────────────────────────────────────────────

    private static async Task<Subject> HeldJobStallAsync(JsonElement given, Case play)
    {
        var claim = BusOperations.JobClaim.Request.Name;
        var dispatcher = play.Keep(new FaultyTransport(respond: (operation, _) => operation == claim
            ? Parsed("""{"status":"running","metadata":{"id":"job-1","type":"mark","userId":"did:web:example.org:users:alice","created":"2026-10-01T00:00:00.000Z","retryCount":0,"maxRetries":1},"params":{"resourceId":"res-1","motivation":"highlighting"},"startedAt":"2026-10-01T00:00:01.000Z","progress":{}}""")
            : throw Unscripted(operation), timeProvider: play.Clock));
        var http = play.Keep(new HttpClient(dispatcher, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan });
        var client = play.Keep(new SemiontClient(new HttpTransport(GatewayUrl, "a-token", WorkerRules.JobClaimChannels,
            httpClient: http, timeProvider: play.Clock, random: play.Random)));
        var claims = client.Job.Claim(Read<JobFilter[]>("""[{"jobType":"mark","params":{"motivation":"highlighting"}}]"""));
        play.Then(claims.StopAsync);
        var job = await claims.NextAsync() ?? throw new CaseFailed("the claims handed no job");
        var stalls = 0;
        _ = play.Running(async stop =>
        {
            await foreach (var _ in claims.Stalled(stop)) Interlocked.Increment(ref stalls);
        });
        return new Subject(() => Volatile.Read(ref stalls), () => job.ProgressAsync(new JobProgress { Percentage = 50 }));
    }

    // ── Discovery ───────────────────────────────────────────────────────────

    private static Task<Subject> DiscoveryAsync(JsonElement given, Case play)
    {
        var document = new LauncherDocument(new Managed([Read<DiscoveredKB>(
            """{"host":"localhost","port":4000,"placement":"local","managedBy":"semiont-launcher","did":"did:web:example.org:kb-a"}""")]));
        play.Running(async stop =>
        {
            await foreach (var _ in LauncherDiscovery.SubscribeDiscovery(document, LauncherDiscovery.DiscoveryInterval, play.Clock, stop)) { }
        });
        return Task.FromResult(new Subject(() => document.Reads, null));
    }

    // ── A client's queries and caches ───────────────────────────────────────

    private static Task<Subject> InvalidationWindowAsync(JsonElement given, Case play)
    {
        var events = BusOperations.BrowseEventsRequested.Request.Name;
        var gateway = play.Keep(new FaultyTransport(respond: (operation, _) => operation == events
            ? Parsed("""{"events":[],"total":0,"resourceId":"res-1"}""")
            : throw Unscripted(operation), timeProvider: play.Clock));
        var http = play.Keep(new HttpClient(gateway, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan });
        var client = play.Keep(new SemiontClient(GatewayUrl, "a-token", http, play.Clock, play.Random));
        play.Running(async stop =>
        {
            await foreach (var _ in client.Browse.Events(Resource).WithCancellation(stop)) { }
        });
        var added = new BusFrame
        {
            Channel = BusChannels.MarkAdded.Name,
            Scope = Resource,
            Payload = Parsed("""{"id":"evt-1","type":"mark:added","timestamp":"2026-10-06T00:00:00.000Z","userId":"did:web:example.org:users:alice","version":1,"payload":{},"metadata":{"sequenceNumber":1},"resourceId":"res-1"}"""),
        };
        // The frame enters the client where its stream hands every frame it reads: the stream carries the resource's
        // scope only once reconnectDebounceMs has passed, and the case delivers before any time has.
        return Task.FromResult(new Subject(() => Sent(gateway, events), () =>
        {
            client.Bus.Receive(new ReceivedBusFrame(added, default));
            return Task.CompletedTask;
        }));
    }

    private static Task<Subject> SaveDebounceAsync(JsonElement given, Case play)
    {
        var saves = new CountedSaves();
        var storage = play.Keep(new LiveCacheStorage(new CachePersistence(saves, "kb-1"), play.Clock, () => false));
        var cache = play.Keep(new Cache<ResourceId, ResourceDescriptor>((key, _) => throw new CaseFailed($"a cache that is only written fetched {key}"), null,
            play.Clock, TimeSpan.FromMilliseconds(ProtocolFacts.Timing("invalidationWindowMs").GetInt32()), storage.Changed("resource")));
        storage.Start([storage.Keep("resource", cache, KeptKeys.ByResource<ResourceDescriptor>())]);
        var changes = 0;
        return Task.FromResult(new Subject(() => saves.Counted, () =>
        {
            cache.Set(Resource, Read<ResourceDescriptor>($$"""{"@context":"https://schema.org/","@id":"res-1","name":"{{++changes}}","representations":[]}"""));
            return Task.CompletedTask;
        }));
    }

    /// <summary>A storage that keeps nothing, and counts what it is given to keep.</summary>
    private sealed class CountedSaves : Semiont.Storage.ISessionStorage
    {
        private int counted;
        internal int Counted => Volatile.Read(ref counted);
        public string? Get(string key) => null;
        public void Set(string key, string value) => Interlocked.Increment(ref counted);
        public void Delete(string key) { }
        public void Update(string key, Func<string?, string?> change) => throw new CaseFailed("a save updated " + key);
        public IDisposable? Subscribe(Action<string, string?> onChange) => null;
    }

    private static Task<Subject> JobFollowerAsync(JsonElement given, Case play)
    {
        var create = BusOperations.JobCreate.Request.Name;
        var status = BusOperations.JobStatusRequested.Request.Name;
        var queue = play.Keep(new FaultyTransport(respond: (operation, _) =>
            operation == create ? Parsed("""{"jobId":"job-1"}""")
            : operation == status ? Parsed("""{"jobId":"job-1","type":"mark","status":"running","userId":"did:web:example.org:users:alice","created":"2026-10-01T00:00:00.000Z"}""")
            : throw Unscripted(operation), timeProvider: play.Clock));
        var http = play.Keep(new HttpClient(queue, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan });
        var client = play.Keep(new SemiontClient(GatewayUrl, "a-token", http, play.Clock, play.Random));
        var highlighting = Read<MarkJobParams>("""{"motivation":"highlighting"}""");
        play.Running(async stop =>
        {
            await foreach (var _ in client.Mark.Delegate(Resource, highlighting).WithCancellation(stop)) { }
        });
        var progressed = new BusFrame
        {
            Channel = BusChannels.JobReportProgress.Name,
            Payload = Parsed("""{"resourceId":"res-1","jobId":"job-1","jobType":"mark","percentage":10,"progress":{"percentage":10}}"""),
        };
        return Task.FromResult(new Subject(() => Sent(queue, status), () =>
        {
            queue.Deliver(progressed);
            return Task.CompletedTask;
        }));
    }

    // ── What a case is played with ──────────────────────────────────────────

    private delegate Task<Subject> Build(JsonElement given, Case play);

    /// <summary>What a case drives: what it counts, and its action, when it has one.</summary>
    private sealed record Subject(Func<int> Counted, Func<Task>? Act);

    private sealed class CaseFailed(string message) : Exception(message);

    /// <summary>A case's clock, random source and what is to be closed once it is over.</summary>
    private sealed class Case : IAsyncDisposable
    {
        private readonly Stack<Func<Task>> undo = new();
        private readonly CancellationTokenSource stopping = new();
        private readonly CancellationTokenSource limit = new(CaseLimit);
        private Func<int> counted = () => 0;

        internal StateCaseClock Clock { get; } = new(Began);
        internal ZeroRandom Random { get; } = new();

        /// <summary>Where the case's clock stands, in whole milliseconds since the case began.</summary>
        internal long AtMs { get; private set; }

        internal void Counts(Func<int> counting) => counted = counting;

        internal T Keep<T>(T owned) where T : IDisposable
        {
            undo.Push(() =>
            {
                owned.Dispose();
                return Task.CompletedTask;
            });
            return owned;
        }

        internal void Then(Func<Task> undoing) => undo.Push(undoing);

        /// <summary><paramref name="work"/> set going, and stopped once the case is over, however it then ends.</summary>
        internal Task Running(Func<CancellationToken, Task> work)
        {
            var task = work(stopping.Token);
            undo.Push(async () =>
            {
                await stopping.CancelAsync();
                await task.WaitAsync(Patience).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
                if (!task.IsCompleted) throw new CaseFailed("what it set going did not stop once the case was over");
            });
            return task;
        }

        /// <summary><paramref name="work"/>, which is to end with what is ready, the clock not moving.</summary>
        internal static async Task<T> AtOnceAsync<T>(Task<T> work)
        {
            try { return await work.WaitAsync(Patience); }
            catch (TimeoutException) { throw new CaseFailed("it did not end without the clock moving"); }
        }

        internal static async Task AtOnceAsync(Task work)
        {
            try { await work.WaitAsync(Patience); }
            catch (TimeoutException) { throw new CaseFailed("it did not end without the clock moving"); }
        }

        /// <summary>Let what is ready run, and what that makes ready, until nothing more is, without moving the clock.</summary>
        internal async Task SettleAsync()
        {
            do
            {
                var seen = Activity();
                for (var quiet = 0; quiet < QuietLooks;)
                {
                    await Task.Delay(Look, limit.Token);
                    var now = Activity();
                    if (now == seen) quiet++;
                    else { seen = now; quiet = 0; }
                }
            } while (Clock.FireNext(Clock.GetTimestamp()));
        }

        private long Activity() => Clock.Changes + counted();

        /// <summary>Settle, then move the clock <paramref name="ms"/> ahead: to each instant a timer falls due on the way, in turn, and what falls due runs there.</summary>
        private async Task PassAsync(long ms)
        {
            await SettleAsync();
            AtMs += ms;
            var until = AtMs * TimeSpan.TicksPerMillisecond;
            while (Clock.FireNext(until)) await SettleAsync();
            await SettleAsync();
        }

        internal async Task PerformAsync(JsonElement step, Subject subject)
        {
            if (step.ValueKind == JsonValueKind.String && step.GetString() == "settle")
            {
                await SettleAsync();
            }
            else if (step.ValueKind == JsonValueKind.String && step.GetString() == "act")
            {
                var act = subject.Act ?? throw new CaseFailed("the subject has no action");
                await AtOnceAsync(act());
                await SettleAsync();
            }
            else if (step.ValueKind == JsonValueKind.Object && step.TryGetProperty("pass", out var passed))
            {
                await PassAsync(DurationMs(passed));
            }
            else if (step.ValueKind == JsonValueKind.Object && step.TryGetProperty("counted", out var expected))
            {
                await SettleAsync();
                var times = subject.Counted();
                if (times != expected.GetInt32()) throw new CaseFailed($"counted {times}, not {expected.GetInt32()}");
            }
            else
            {
                throw new CaseFailed("no step this runner performs");
            }
        }

        public async ValueTask DisposeAsync()
        {
            await stopping.CancelAsync();
            while (undo.TryPop(out var next)) await next();
            stopping.Dispose();
            limit.Dispose();
        }
    }

    private enum StreamAnswer { Holds, Refuses, Never }

    /// <summary>A gateway in this process. It answers each request at once, as the subject has it answer, and counts what it is asked.</summary>
    private sealed class Gateway(StreamAnswer stream, int? retryAfterSeconds, params string[] unanswered) : HttpMessageHandler
    {
        private readonly object gate = new();
        private readonly Dictionary<string, int> asked = new(StringComparer.Ordinal);
        private int closed;

        /// <summary>How many requests of <paramref name="path"/> it has been asked.</summary>
        internal int Asked(string path) { lock (gate) return asked.GetValueOrDefault(path); }

        /// <summary>How many of the streams it held open their readers have closed.</summary>
        internal int Closed => Volatile.Read(ref closed);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri?.AbsolutePath ?? throw new CaseFailed("a request named no address");
            lock (gate) asked[path] = asked.GetValueOrDefault(path) + 1;
            if (unanswered.Contains(path, StringComparer.Ordinal) || path == Subscribe && stream == StreamAnswer.Never)
                return await NeverAnsweredAsync(cancellationToken);
            if (path != Subscribe) throw new CaseFailed($"the gateway was asked {request.Method} {path}, which this subject does not have it answer");
            if (stream == StreamAnswer.Holds)
            {
                var content = new StreamContent(new HeldOpen(() => Interlocked.Increment(ref closed)));
                content.Headers.ContentType = new("text/event-stream");
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
            }
            var refused = new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) { Content = JsonContent.Create(new { error = "The gateway is not ready" }) };
            if (retryAfterSeconds is int seconds) refused.Headers.TryAddWithoutValidation("Retry-After", seconds.ToString(CultureInfo.InvariantCulture));
            return refused;
        }

        /// <summary>Wait for an answer that never comes: until whoever waits gives up.</summary>
        private static async Task<HttpResponseMessage> NeverAnsweredAsync(CancellationToken cancellation)
        {
            await new TaskCompletionSource().Task.WaitAsync(cancellation);
            throw new CaseFailed("an answer nobody gives was given");
        }
    }

    /// <summary>The body of a stream a gateway holds open and says nothing on. Its reader waits on it until it closes it.</summary>
    private sealed class HeldOpen(Action closed) : Stream
    {
        private readonly TaskCompletionSource closing = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int disposed;

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException("A stream held open is read asynchronously");
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await closing.Task.WaitAsync(cancellationToken);
            return 0;
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        protected override void Dispose(bool disposing)
        {
            if (disposing && Interlocked.Exchange(ref disposed, 1) == 0)
            {
                closing.TrySetResult();
                closed();
            }
            base.Dispose(disposing);
        }
    }

    /// <summary>
    /// A knowledge base that trusts an issuer, and the issuer, in this process: what a device grant asks. It mints a code
    /// that lives 900 seconds, with the interval the case states, and answers each ask of its token endpoint with the
    /// next of <paramref name="answers"/>, the last repeating.
    /// </summary>
    private sealed class DeviceIssuer(int? intervalSeconds, string[] answers) : HttpMessageHandler
    {
        private int tokenAsks;

        internal int TokenAsks => Volatile.Read(ref tokenAsks);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var address = request.RequestUri ?? throw new CaseFailed("a request named no address");
            var issuer = new Uri(IssuerUrl);
            return Task.FromResult((address.Host, address.AbsolutePath) switch
            {
                ("gateway.test", "/.well-known/oauth-protected-resource") => Answer(HttpStatusCode.OK, new Dictionary<string, object>
                {
                    ["resource"] = GatewayUrl,
                    ["authorization_servers"] = new[] { IssuerUrl },
                    ["bearer_methods_supported"] = new[] { "header" },
                }),
                var (host, path) when host == issuer.Host && path == issuer.AbsolutePath + "/.well-known/openid-configuration" =>
                    Answer(HttpStatusCode.OK, new Dictionary<string, object>
                    {
                        ["issuer"] = IssuerUrl,
                        ["authorization_endpoint"] = IssuerUrl + "/auth",
                        ["token_endpoint"] = IssuerUrl + "/token",
                        ["device_authorization_endpoint"] = IssuerUrl + "/device",
                    }),
                var (host, path) when host == issuer.Host && path == issuer.AbsolutePath + "/device" => Answer(HttpStatusCode.OK, Minted()),
                var (host, path) when host == issuer.Host && path == issuer.AbsolutePath + "/token" => Answer(HttpStatusCode.BadRequest,
                    new Dictionary<string, object> { ["error"] = answers[Math.Min(Interlocked.Increment(ref tokenAsks) - 1, answers.Length - 1)] }),
                _ => throw new CaseFailed($"the issuer was asked {request.Method} {address}, which a device grant does not ask"),
            });
        }

        private Dictionary<string, object> Minted()
        {
            var minted = new Dictionary<string, object>
            {
                ["device_code"] = "the-device-code",
                ["user_code"] = "WDJB-MJHT",
                ["verification_uri"] = "http://issuer.test/device",
                ["expires_in"] = 900,
            };
            if (intervalSeconds is int interval) minted["interval"] = interval;
            return minted;
        }

        private static HttpResponseMessage Answer(HttpStatusCode status, Dictionary<string, object> body) =>
            new(status) { Content = JsonContent.Create(body) };
    }

    /// <summary>A launcher's document: <paramref name="first"/> at the first read, and unchanged at every read after it.</summary>
    private sealed class LauncherDocument(Managed first) : DiscoveryTransport
    {
        private int reads;

        internal int Reads => Volatile.Read(ref reads);

        public Task<DiscoveryRead> ReadAsync(CancellationToken cancellation = default) =>
            Task.FromResult<DiscoveryRead>(Interlocked.Increment(ref reads) == 1 ? first : new Unchanged());
    }
}
