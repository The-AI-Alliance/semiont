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
// given, its transport heals no refusal itself, and its renewal records the token it is handed. A `closing` row's is the
// one SemiontSession.FromKeptAsync makes, its client keeping in a storage that refuses every write.
public sealed partial class TransportTests
{
    private const string RegistryErrorsCases = "session/registry-errors-cases.json";

    /// <summary>What a runner waits for once a case's last error is said.</summary>
    private enum SaidEffect { RegistryError, Renewal, PermissionRefusal }

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

    // C#'s reader does one thing more than the table holds: the first of a session's own errors said once the session has
    // ended it also says through the session's signals as that end, which C#'s factories have no other way to raise. The
    // refusal that ends the session here is read once a renewal has changed its token, which no row says: the registry
    // hands the renewal the token the session then holds, which the issuer refuses.
    [Fact]
    public async Task TheFirstOwnErrorSaidOnceASessionHasEndedIsSaidThroughItsSignalsAsThatEnd()
    {
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var access = TokenTests.Jwt(new { exp = now + 3600 });
        var renewed = TokenTests.Jwt(new { exp = now + 7200 });
        var store = new MemoryStorage();
        var kb = RegistryKb("one", "one.test");
        RegistryStorage.SaveKnowledgeBases(store, [kb]);
        var built = new TaskCompletionSource<(SemiontSession Session, KeptSession Kept)>(TaskCreationOptions.RunContinuationsAsynchronously);
        var factory = ScriptedErrorsFactory(clock, access,
            (holding, _) => holding == access ? Task.FromResult<string?>(renewed)
                : Task.FromException<string?>(new SignInError(ProtocolFacts.SignInError("exchange"), "the issuer refuses the grant", 400)),
            (_, session, kept) => built.SetResult((session, kept)));
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory, clock));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await browser.SetActiveKbAsync(kb.Id, deadline.Token);
        var (session, kept) = await built.Task.WaitAsync(deadline.Token);
        var signals = Assert.IsType<SessionSignals>(browser.State.ActiveSignals);
        await using var errors = browser.Errors(deadline.Token).GetAsyncEnumerator();

        kept.Say(new TransportError(ProtocolFacts.Error(401), "the gateway refuses the token", 401));
        await foreach (var token in session.Token.WithCancellation(deadline.Token))
            if (token == renewed) break;
        // Joins the renewal if it is still finishing, and renews nothing: the session no longer holds that token. A refusal
        // read before that renewal finished would share it, and the session would not end.
        Assert.Equal(renewed, await session.RefreshAsync(access, deadline.Token));
        kept.Say(new TransportError(ProtocolFacts.Error(401), "the gateway refuses the renewed token", 401));
        Assert.True(await errors.MoveNextAsync(), "the registry's errors ended before the session said it ended");
        Assert.Equal(ProtocolFacts.SessionError("refresh-exhausted"), errors.Current.Code);
        Assert.Equal(new SessionEnded(SessionEndReason.Expired), signals.SessionEnded.Value);
    }

    /// <summary>
    /// A registry whose session says the row's errors as its factory builds it or once it is active. The runner waits for
    /// the effect of the last, then closes the registry, and holds every code the registry said until its errors end and
    /// every refusal for lack of permission said through the session's signals until they close: the scripted session
    /// keeps nothing, so a correct registry says nothing more once that effect is seen.
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
        var renews = row.TryGetProperty("renewedWith", out _);
        if (renews && Text(row, "renewedWith") != "held")
            throw new InvalidOperationException(why + ": no session is renewed with " + Text(row, "renewedWith"));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var renewed = TokenTests.Jwt(new { exp = now + 7200 });
        var handed = Channel.CreateUnbounded<string?>();
        var built = new TaskCompletionSource<(SessionSignals Signals, SemiontSession Session, KeptSession Kept)>(TaskCreationOptions.RunContinuationsAsynchronously);
        var told = new TaskCompletionSource<(string Held, IAsyncEnumerator<PermissionDenied?> Notices, Task<bool> NextNotice)>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        (string, IAsyncEnumerator<PermissionDenied?>, Task<bool>) Tell(SessionSignals signals, SemiontSession session, KeptSession kept)
        {
            // Read from before the first error is said, so each refusal said through them is read, not only the latest.
            var notices = signals.PermissionDenied.GetAsyncEnumerator(deadline.Token);
            var next = notices.MoveNextAsync().AsTask();
            // Nothing renews the session before the registry reads a refusal, so the token it holds as that is read is the
            // one it holds now.
            var held = session.Token.Value ?? throw new InvalidOperationException(why + ": the session holds no token");
            foreach (var error in saying) kept.Say(error);
            return (held, notices, next);
        }
        var factory = ScriptedErrorsFactory(clock, TokenTests.Jwt(new { exp = now + 3600 }),
            (holding, _) =>
            {
                handed.Writer.TryWrite(holding);
                return Task.FromResult<string?>(renewed);
            },
            (signals, session, kept) =>
            {
                if (opening) told.SetResult(Tell(signals, session, kept));
                built.SetResult((signals, session, kept));
            });
        var store = new MemoryStorage();
        var kb = RegistryKb("one", "one.test");
        RegistryStorage.SaveKnowledgeBases(store, [kb]);
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory, clock));
        await browser.SetActiveKbAsync(kb.Id, deadline.Token);
        var active = await built.Task.WaitAsync(deadline.Token);
        await using IAsyncEnumerator<SemiontError> errors = browser.Errors(deadline.Token).GetAsyncEnumerator();
        var nextError = errors.MoveNextAsync().AsTask();
        if (!opening) told.SetResult(Tell(active.Signals, active.Session, active.Kept));
        var (held, notices, nextNotice) = await told.Task.WaitAsync(deadline.Token);

        var codes = new List<string>();
        var refusals = new List<string?>();
        var renewals = new List<string?>();
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
                break;
            case SaidEffect.Renewal:
                renewals.Add(await handed.Reader.ReadAsync(deadline.Token));
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
        if (renews && renewals.Count == 0) renewals.Add(await handed.Reader.ReadAsync(deadline.Token));

        await browser.DisposeAsync();
        codes.AddRange((await SaidUntilEndAsync(errors, nextError, deadline.Token)).Select(error => error.Code));
        while (await nextNotice.WaitAsync(deadline.Token))
        {
            if (notices.Current is { } notice) refusals.Add(notice.Detail);
            nextNotice = notices.MoveNextAsync().AsTask();
        }
        await notices.DisposeAsync();

        Assert.True(RegistryErrors(row).SequenceEqual(codes), why + ": the registry said [" + string.Join(", ", codes) + "]");
        string?[] refused = row.TryGetProperty("permissionDenied", out _) ? [Text(row, "permissionDenied")] : [];
        Assert.True(refused.SequenceEqual(refusals),
            why + ": the session's signals said [" + string.Join(", ", refusals) + "] as refusals for lack of permission");
        if (renews)
        {
            Assert.True(renewals[0] == held, why + ": the renewal was handed another token than the one the session held");
            return;
        }
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
        var signIn = new MemorySignIn(RegistryTokens() with
        {
            Access = TokenTests.Jwt(new { exp = clock.GetUtcNow().ToUnixTimeSeconds() + 3600 }),
            PersonKey = RegistryStorage.PersonKey(UserId.Parse(kb.Did + ":users:alice")),
        });
        using var server = new Handler();
        using var http = new HttpClient(server);
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
        var factory = new RegistryFactory((options, cancellation) => SemiontSession.FromKeptAsync(Target(options.Kb), signIn,
            new RefusesEveryWrite(), http, clock, validate: false, cancellation: cancellation));
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory, clock));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await browser.SetActiveKbAsync(kb.Id, deadline.Token);
        var session = Assert.IsType<SemiontSession>(Assert.IsType<OpenedSession>(browser.State.ActiveSession).Session);
        await session.ReadyAsync(deadline.Token);
        if (row.GetProperty("owed").GetBoolean())
            Assert.Equal("fresh", (await session.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(deadline.Token)).Name);

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

    /// <summary>The effect of a case's last `said`: its own error said on the registry's errors, a refusal for want of a
    /// valid token renewing the session, or a refusal for lack of permission said through its signals.</summary>
    private static SaidEffect EffectOf(JsonElement said, string why) =>
        said.TryGetProperty("own", out _) ? SaidEffect.RegistryError : Text(said, "transport") switch
        {
            "unauthorized" => SaidEffect.Renewal,
            "forbidden" => SaidEffect.PermissionRefusal,
            var other => throw new InvalidOperationException(why + ": a registry does nothing a runner can wait for with " + other),
        };

    private static string[] RegistryErrors(JsonElement row) =>
        row.GetProperty("registryErrors").EnumerateArray().Select(code => Assert.IsType<string>(code.GetString())).ToArray();

    /// <summary>
    /// A factory that builds a scripted session and reads none of its errors. Its sign-in holds <paramref name="access"/>,
    /// whom the gateway names as one person of the knowledge base; each renewal is <paramref name="renew"/>, handed the token
    /// the session holds; its transport renews nothing itself. <paramref name="built"/> is given the session's signals, the
    /// session and what keeps its sign-in, which says on its errors, before the factory hands the session back.
    /// </summary>
    private static RegistryFactory ScriptedErrorsFactory(TimeProvider clock, string access,
        Func<string?, CancellationToken, Task<string?>> renew, Action<SessionSignals, SemiontSession, KeptSession> built) =>
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
                (_, _) => Task.FromResult(user), clock, new ZeroRandom());
            await kept.ReadyAsync(cancellation);
            var server = new Handler();
            var http = new HttpClient(server);
            server.Answer = sent => Reply(server, sent, BusOperations.BrowseKbRequested.Result.Name,
                new { response = new { domain, name = options.Kb.Label } });
            var client = new SemiontClient(new HttpTransport("https://kb.test", kept.State.Token, BusRegistry.BridgedChannels,
                httpClient: http, timeProvider: clock));
            var session = new SemiontSession(Target(options.Kb), client, kept);
            built(options.Signals, session, kept);
            return new OpenedSession(client, async () =>
            {
                client.Dispose();
                await client.Flushed;
                session.Dispose();
                http.Dispose();
            }, session);
        });

    /// <summary>A storage that holds nothing and refuses every write, as a host's storage that cannot write does.</summary>
    private sealed class RefusesEveryWrite : ISessionStorage
    {
        public string? Get(string key) => null;
        public void Set(string key, string value) => throw new IOException("The storage cannot write " + key);
        public void Delete(string key) => throw new IOException("The storage cannot delete " + key);
        public void Update(string key, Func<string?, string?> change) => throw new IOException("The storage cannot write " + key);
        public IDisposable? Subscribe(Action<string, string?> onChange) => null;
    }
}
