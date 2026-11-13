using System.Text.Json;
using System.Threading.Channels;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Registry;
using Semiont.Session;
using Semiont.SignIn;
using Semiont.State;
using Semiont.Storage;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

// How a registry reads the errors of each session it activates, held to
// protocol/specs/src/session/registry-errors-cases.json, the table every SDK runs. Neither factory here reads any of
// the session's errors. A `cases` row's session is scripted: it says each error the row says on its errors stream as
// given, its transport heals no refusal itself, and its renewal records the token it is handed, so a runner fails a
// registry that renews it. A `closing` row's is the one SemiontSession.FromKeptAsync makes, its client keeping in a
// storage that refuses every write.
public sealed partial class TransportTests
{
    private const string RegistryErrorsCases = "session/registry-errors-cases.json";

    /// <summary>What a runner waits for once a case's last error is said.</summary>
    private enum SaidEffect { RegistryError, PermissionRefusal }

    [Fact]
    public async Task ARegistryReadsEachSessionsErrorsAsTheirCasesSay()
    {
        using var table = ReadSpec(RegistryErrorsCases);
        var rows = table.RootElement.GetProperty("cases").EnumerateArray().ToArray();
        Assert.NotEmpty(rows);
        foreach (var row in rows) await RegistryErrorsCaseAsync(row);
    }

    [Fact]
    public async Task ARegistrysCloseReadsItsActiveSessionsErrorsToTheirEndAsTheirCasesSay()
    {
        using var table = ReadSpec(RegistryErrorsCases);
        var rows = table.RootElement.GetProperty("closing").EnumerateArray().ToArray();
        Assert.NotEmpty(rows);
        foreach (var row in rows) await RegistryClosingCaseAsync(row);
    }

    // Of what the registry says before anyone reads its errors, the latest errorsKeptForFirstReaderCount
    // (protocol/specs/src/client/timing.json) are kept, the oldest dropped beyond that: its first reader hears those, in
    // the order said. The session says them once it is active, so the registry, its one reader, hears every one.
    [Fact]
    public async Task TheFirstReaderOfARegistryNobodyReadHearsTheLatestItKeptInOrder()
    {
        var most = ProtocolFacts.Timing("errorsKeptForFirstReaderCount").GetInt32();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var clock = new TestClock();
        var built = new TaskCompletionSource<(SessionSignals Signals, KeptSession Kept)>(TaskCreationOptions.RunContinuationsAsynchronously);
        var factory = ScriptedErrorsFactory(clock, TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() + 3600 }),
            (_, _) => Task.FromResult<string?>(null), (signals, kept) => built.SetResult((signals, kept)));
        var store = new MemoryStorage();
        var kb = RegistryKb("one", "one.test");
        RegistryStorage.SaveKnowledgeBases(store, [kb]);
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory, clock));
        await browser.SetActiveKbAsync(kb.Id, deadline.Token);
        var (signals, kept) = await built.Task.WaitAsync(deadline.Token);

        var said = Enumerable.Range(0, most + 3)
            .Select<int, SemiontError>(at => new SessionError(ProtocolFacts.SessionError("keep-failed"), $"error {at}")).ToArray();
        foreach (var error in said) kept.Say(error);
        // The registry reads the session's errors in the order said: once the refusal said after them reaches the signals,
        // it has said every one.
        kept.Say(new TransportError(ProtocolFacts.Error(403), "said after them", 403));
        await foreach (var denied in signals.PermissionDenied.WithCancellation(deadline.Token))
            if (denied is not null) break;

        await using IAsyncEnumerator<SemiontError> errors = browser.Errors(deadline.Token).GetAsyncEnumerator();
        var told = errors.MoveNextAsync().AsTask();
        await browser.DisposeAsync();
        Assert.Equal(said.TakeLast(most), await SaidUntilEndAsync(errors, told, deadline.Token));
    }

    /// <summary>
    /// A registry whose session says the row's errors as its factory builds it or once it is active. The runner waits for
    /// the effect of the last, and holds that the session's signals have said by then the last refusal for lack of
    /// permission said before it. It then closes the registry, and holds every code the registry said until its errors
    /// end, every refusal for lack of permission said through the session's signals until they close, and that nothing
    /// renewed the session: the scripted session keeps nothing, so a correct registry says nothing more once that effect
    /// is seen.
    /// </summary>
    private static async Task RegistryErrorsCaseAsync(JsonElement row)
    {
        var why = Text(row, "why");
        var said = row.GetProperty("said").EnumerateArray().ToArray();
        var saying = said.Select(SaidError).ToArray();
        var effect = EffectOf(said[^1], why);
        var opening = Text(row, "while") switch
        {
            "opening" => true,
            "active" => false,
            var other => throw new InvalidOperationException(why + ": no session says its errors while " + other),
        };
        string?[] refused = row.TryGetProperty("permissionDenied", out _) ? [Text(row, "permissionDenied")] : [];
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var renewed = TokenTests.Jwt(new { exp = now + 7200 });
        var handed = Channel.CreateUnbounded<string?>();
        var built = new TaskCompletionSource<(SessionSignals Signals, KeptSession Kept)>(TaskCreationOptions.RunContinuationsAsynchronously);
        var told = new TaskCompletionSource<(IAsyncEnumerator<PermissionDenied?> Notices, Task<bool> NextNotice)>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        (IAsyncEnumerator<PermissionDenied?>, Task<bool>) Tell(SessionSignals signals, KeptSession kept)
        {
            // Read from before the first error is said, so each refusal said through them is read, not only the latest.
            var notices = signals.PermissionDenied.GetAsyncEnumerator(deadline.Token);
            var next = notices.MoveNextAsync().AsTask();
            foreach (var error in saying) kept.Say(error);
            return (notices, next);
        }
        var factory = ScriptedErrorsFactory(clock, TokenTests.Jwt(new { exp = now + 3600 }),
            (holding, _) =>
            {
                handed.Writer.TryWrite(holding);
                return Task.FromResult<string?>(renewed);
            },
            (signals, kept) =>
            {
                if (opening) told.SetResult(Tell(signals, kept));
                built.SetResult((signals, kept));
            });
        var store = new MemoryStorage();
        var kb = RegistryKb("one", "one.test");
        RegistryStorage.SaveKnowledgeBases(store, [kb]);
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory, clock));
        await browser.SetActiveKbAsync(kb.Id, deadline.Token);
        var active = await built.Task.WaitAsync(deadline.Token);
        await using IAsyncEnumerator<SemiontError> errors = browser.Errors(deadline.Token).GetAsyncEnumerator();
        var nextError = errors.MoveNextAsync().AsTask();
        if (!opening) told.SetResult(Tell(active.Signals, active.Kept));
        var (notices, nextNotice) = await told.Task.WaitAsync(deadline.Token);

        var codes = new List<string>();
        var refusals = new List<string?>();
        switch (effect)
        {
            case SaidEffect.RegistryError:
                while (true)
                {
                    Assert.True(await nextError.WaitAsync(deadline.Token),
                        why + ": the registry's errors ended after [" + string.Join(", ", codes) + "], before the session's last was said");
                    var error = errors.Current;
                    codes.Add(error.Code);
                    nextError = errors.MoveNextAsync().AsTask();
                    if (ReferenceEquals(error, saying[^1])) break;
                }
                var latest = active.Signals.PermissionDenied.Value?.Detail;
                Assert.True(refused.LastOrDefault() == latest,
                    why + ": as the registry said the session's last error, its signals had said " + (latest ?? "nothing") + " as a refusal for lack of permission");
                break;
            case SaidEffect.PermissionRefusal:
                while (refusals.Count == 0)
                {
                    Assert.True(await nextNotice.WaitAsync(deadline.Token),
                        why + ": the session's signals closed before a refusal for lack of permission was said");
                    if (notices.Current is { } notice) refusals.Add(notice.Detail);
                    nextNotice = notices.MoveNextAsync().AsTask();
                }
                break;
        }

        await browser.DisposeAsync();
        codes.AddRange((await SaidUntilEndAsync(errors, nextError, deadline.Token)).Select(error => error.Code));
        while (await nextNotice.WaitAsync(deadline.Token))
        {
            if (notices.Current is { } notice) refusals.Add(notice.Detail);
            nextNotice = notices.MoveNextAsync().AsTask();
        }
        await notices.DisposeAsync();

        Assert.True(RegistryErrors(row).SequenceEqual(codes), why + ": the registry said [" + string.Join(", ", codes) + "]");
        Assert.True(refused.SequenceEqual(refusals),
            why + ": the session's signals said [" + string.Join(", ", refusals) + "] as refusals for lack of permission");
        var renewals = new List<string?>();
        while (handed.Reader.TryRead(out var stray)) renewals.Add(stray);
        Assert.True(renewals.Count == 0, why + ": the session was renewed, handed " + string.Join(", ", renewals));
    }

    /// <summary>
    /// A registry closed while its active session's client owes a save, or none, to a storage that refuses every write. The
    /// session's sign-in names its person, so its client keeps for them from the start, and a read's save waits for a
    /// debounce that never passes on this clock: the closing's flush is that save.
    /// </summary>
    private static async Task RegistryClosingCaseAsync(JsonElement row)
    {
        var why = Text(row, "why");
        var clock = new TestClock();
        var store = new MemoryStorage();
        var kb = RegistryKb("one", "one.test");
        RegistryStorage.SaveKnowledgeBases(store, [kb]);
        var signIn = new MemorySignIn(NamingSignIn(kb, clock));
        var keeping = new WatchedStorage(RefuseTheWrite);
        var factory = new RegistryFactory((options, cancellation) => KeepingSessionAsync(options.Kb, signIn, keeping, clock, cancellation));
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory, clock));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await browser.SetActiveKbAsync(kb.Id, deadline.Token);
        var opened = Assert.IsType<OpenedSession>(browser.State.ActiveSession);
        await Assert.IsType<SemiontSession>(opened.Session).ReadyAsync(deadline.Token);
        if (row.GetProperty("owed").GetBoolean()) await OwingItsSaveAsync(opened, deadline.Token);

        await using IAsyncEnumerator<SemiontError> errors = browser.Errors(deadline.Token).GetAsyncEnumerator();
        var told = errors.MoveNextAsync().AsTask();
        await browser.DisposeAsync();
        var codes = (await SaidUntilEndAsync(errors, told, deadline.Token)).Select(error => error.Code).ToArray();
        Assert.True(RegistryErrors(row).SequenceEqual(codes), why + ": the registry said [" + string.Join(", ", codes) + "] as it closed");
    }

    /// <summary>What a case's `said` entry is: one of the session's own errors, by its code, or a failure of its transport,
    /// by its code, with its message.</summary>
    private static SemiontError SaidError(JsonElement said)
    {
        if (said.TryGetProperty("own", out _)) return new SessionError(Text(said, "own"), "said as its case says");
        return new TransportError(Text(said, "transport"), Text(said, "message"));
    }

    /// <summary>The effect of a case's last `said`: its own error said on the registry's errors, or a refusal for lack of
    /// permission said through its signals.</summary>
    private static SaidEffect EffectOf(JsonElement said, string why) =>
        said.TryGetProperty("own", out _) ? SaidEffect.RegistryError : Text(said, "transport") switch
        {
            "forbidden" => SaidEffect.PermissionRefusal,
            var other => throw new InvalidOperationException(why + ": a registry does nothing a runner can wait for with " + other),
        };

    private static string[] RegistryErrors(JsonElement row) =>
        row.GetProperty("registryErrors").EnumerateArray().Select(code => Assert.IsType<string>(code.GetString())).ToArray();

    /// <summary>
    /// A factory that builds a scripted session and reads none of its errors. Its sign-in holds <paramref name="access"/>,
    /// whom the gateway names as one person of the knowledge base; each renewal is <paramref name="renew"/>, handed the token
    /// the session holds; its transport renews nothing itself. <paramref name="built"/> is given the session's signals and
    /// what keeps its sign-in, which says on its errors, before the factory hands the session back.
    /// </summary>
    private static RegistryFactory ScriptedErrorsFactory(TimeProvider clock, string access,
        Func<string?, CancellationToken, Task<string?>> renew, Action<SessionSignals, KeptSession> built) =>
        new(async (options, cancellation) =>
        {
            var domain = options.Kb.Did["did:web:".Length..];
            var user = Required<UserResponse>(JsonSerializer.SerializeToElement(new
            {
                did = options.Kb.Did + ":users:alice",
                domain,
                email = (string?)null,
                name = (string?)null,
                image = (string?)null,
            }));
            var kept = new KeptSession(new MemorySignIn(RegistryTokens() with { Access = access }), renew,
                (_, _) => Task.FromResult(user), clock, new ZeroRandom(), options.Signals.NotifySessionEnded);
            await kept.ReadyAsync(cancellation);
            var server = new Handler();
            var http = new HttpClient(server);
            server.Answer = sent => Reply(server, sent, BusOperations.BrowseKbRequested.Result.Name,
                new { response = new { domain, name = options.Kb.Label } });
            var client = new SemiontClient(new HttpTransport("https://kb.test", kept.State.Token, BusRegistry.BridgedChannels,
                httpClient: http, timeProvider: clock));
            var session = new SemiontSession(Target(options.Kb), client, kept);
            built(options.Signals, kept);
            return new OpenedSession(client, async () =>
            {
                client.Dispose();
                await client.Flushed;
                session.Dispose();
                http.Dispose();
            }, session);
        });

    /// <summary>A sign-in, unexpired on <paramref name="clock"/>, that names alice, one person of <paramref name="kb"/>: the
    /// client of a session over it keeps for her from its start.</summary>
    private static StoredSession NamingSignIn(KnowledgeBase kb, TimeProvider clock) => RegistryTokens() with
    {
        Access = TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() + 3600 }),
        PersonKey = AlicesKey(kb),
    };

    private static string AlicesKey(KnowledgeBase kb) => RegistryStorage.PersonKey(UserId.Parse(kb.Did + ":users:alice"));

    /// <summary>Where the save a client of <paramref name="kb"/>'s left owing by <see cref="OwingItsSaveAsync"/> is
    /// written: what it keeps for alice of the resource it read.</summary>
    private static string OwedSave(KnowledgeBase kb) => RegistryStorage.CacheKey(kb.Id, AlicesKey(kb), "resource");

    /// <summary>
    /// The session SemiontSession.FromKeptAsync makes of <paramref name="kb"/> over <paramref name="signIn"/>, which names
    /// its person, so its client keeps in <paramref name="keeping"/> from the start. It asks nobody who its token is. Its
    /// gateway describes the knowledge base as itself, and each resource it is asked for as `fresh`; ending the session
    /// ends its gateway.
    /// </summary>
    private static async Task<OpenedSession> KeepingSessionAsync(KnowledgeBase kb, ISignInKept signIn, ISessionStorage keeping,
        TimeProvider clock, CancellationToken cancellation)
    {
        var server = new Handler();
        var http = new HttpClient(server);
        server.Answer = sent =>
        {
            if (Text(sent, "channel") == BusOperations.BrowseKbRequested.Request.Name)
            {
                Reply(server, sent, BusOperations.BrowseKbRequested.Result.Name,
                    new { response = new { domain = kb.Did["did:web:".Length..], name = kb.Label } });
                return;
            }
            Assert.Equal(BusOperations.BrowseResourceRequested.Request.Name, Text(sent, "channel"));
            Reply(server, sent, BusOperations.BrowseResourceRequested.Result.Name,
                new { response = new { resource = Described(Text(sent.GetProperty("payload"), "resourceId"), "fresh"), lastSequence = 1 } });
        };
        var opened = await SemiontSession.FromKeptAsync(Target(kb), signIn, keeping, http, clock, validate: false, cancellation: cancellation);
        return new OpenedSession(opened.Client, async () =>
        {
            try { await opened.DisposeAsync(); }
            finally { http.Dispose(); }
        }, opened.Session);
    }

    /// <summary>Leaves <paramref name="opened"/>'s client owing its save: a read of a resource, whose save waits out a
    /// debounce that never passes on the runner's clock, so the client's closing flush is the first to make it.</summary>
    private static async Task OwingItsSaveAsync(OpenedSession opened, CancellationToken cancellation) =>
        Assert.Equal("fresh", (await opened.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(cancellation)).Name);

    /// <summary>A storage's refusal of a write, as a host's storage that cannot write refuses it.</summary>
    private static void RefuseTheWrite(string key) => throw new IOException("The storage cannot write " + key);

    /// <summary>A storage in memory that subscribes no one, and hands the key of each write to <paramref name="writing"/>
    /// before it makes it: the write is refused when <paramref name="writing"/> throws, and held while it waits.</summary>
    private sealed class WatchedStorage(Action<string> writing) : ISessionStorage
    {
        private readonly MemoryStorage values = new();

        public string? Get(string key) => values.Get(key);

        public void Set(string key, string value)
        {
            writing(key);
            values.Set(key, value);
        }

        public void Delete(string key)
        {
            writing(key);
            values.Delete(key);
        }

        public void Update(string key, Func<string?, string?> change)
        {
            writing(key);
            values.Update(key, change);
        }

        public IDisposable? Subscribe(Action<string, string?> onChange) => null;
    }
}
