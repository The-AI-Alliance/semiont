using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Registry;
using Semiont.State;
using Semiont.Storage;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

// What a client keeps of one person, and when it is read, written and deleted, held to
// protocol/specs/src/session/persisted-cases.json, the table every SDK runs. A registry's session is
// HttpSessionFactory's, which opens once its start has asked who the token is: a gateway that names the
// person only after the client is first asked leaves the start's ask unanswered and names them on the ask a
// renewal makes, and every startup row runs again with the start's ask answered, where nothing is asked before.
// For the same reason a token found `expired` is forgotten by the start's refused renewal, before the factory
// makes the client; an `unexpired` one is refused once the client is open and holds a value it has not written.
// C# builds no keeping session over a memory sign-in, so `holder` changes the registry's sign-in through
// RegistryStorage.KeptIn, what holds it in the storage the client keeps in.
public sealed partial class TransportTests
{
    private const string PersistedCases = "session/persisted-cases.json";
    private const string CaseKb = "kb-a";
    private static readonly TimeSpan SaveDebounce = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("saveDebounceMs").GetInt32());

    [Fact]
    public void PersistedKeysFollowTheirCases()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        foreach (var person in root.GetProperty("people").EnumerateObject())
            Assert.True(Text(person.Value, "personKey") == RegistryStorage.PersonKey(UserId.Parse(Text(person.Value, "did"))), person.Name);
        var rows = root.GetProperty("keys").EnumerateArray().ToArray();
        Assert.NotEmpty(rows);
        foreach (var row in rows)
        {
            var why = Text(row, "why");
            var kbId = Text(row, "kbId");
            var personKey = RegistryStorage.PersonKey(UserId.Parse(Text(row, "did")));
            Assert.True(Text(row, "personKey") == personKey, why + ": the person's key is " + personKey);
            Assert.True(Text(row, "lastEventIdKey") == RegistryStorage.LastEventIdKey(kbId, personKey), why + ": the stream's places");
            var cacheKeys = row.GetProperty("cacheKeys").EnumerateObject().ToArray();
            Assert.True(cacheKeys.Select(key => key.Name).SequenceEqual(LiveQueries.PersistedQueries),
                why + ": the client persists " + string.Join(", ", LiveQueries.PersistedQueries));
            foreach (var key in cacheKeys)
                Assert.True(key.Value.GetString() == RegistryStorage.CacheKey(kbId, personKey, key.Name), why + ": " + key.Name);
        }
    }

    [Fact]
    public async Task ForgettingASignInDeletesWhatIsKeptForThePersonItNames()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var rows = root.GetProperty("forget").EnumerateArray().ToArray();
        Assert.NotEmpty(rows);
        foreach (var row in rows) await ForgetCaseAsync(root, row);
    }

    [Fact]
    public async Task ASessionKeepsForItsPersonOnceTheGatewayNamesThem()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var rows = root.GetProperty("startup").EnumerateArray().ToArray();
        Assert.NotEmpty(rows);
        foreach (var row in rows)
        {
            await StartupCaseAsync(root, row, namedLate: true);
            await StartupCaseAsync(root, row, namedLate: false);
        }
    }

    [Fact]
    public async Task ASignInChangedElsewhereKeepsOnlyARenewalsWrites()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var jo = Text(root.GetProperty("people").GetProperty("jo"), "personKey");
        var joResource = Text(PersonKeysRow(root, CaseKb, jo).GetProperty("cacheKeys"), "resource");
        var rows = root.GetProperty("crossTab").EnumerateArray().ToArray();
        Assert.NotEmpty(rows);
        foreach (var row in rows)
        {
            var why = Text(row, "why");
            var clock = new TestClock();
            var now = clock.GetUtcNow().ToUnixTimeSeconds();
            var storage = new ExternallyWritableStorage();
            RegistryStorage.StoreSession(storage, CaseKb, RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }), PersonKey = jo });
            using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
            gateway.Name(true);
            using var signals = new SessionSignals();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var opened = await new HttpSessionFactory(gateway.Http, clock)
                .OpenAsync(new SessionFactoryOptions(RegistryKb(CaseKb, "kb-a.test"), storage, signals, _ => { }), deadline.Token);
            try
            {
                Assert.Equal("fresh", (await opened.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(deadline.Token)).Name);
                Assert.True(storage.Get(joResource) is null, why + ": the client has not yet written what it holds");
                var stored = row.GetProperty("stored");
                storage.WriteFromElsewhere(RegistryStorage.SessionKey(CaseKb), stored.ValueKind == JsonValueKind.Null ? null :
                    RegistryStorage.Write(RegistryTokens() with
                    {
                        Access = TokenTests.Jwt(new { exp = now + 5400 }),
                        Refresh = "refresh written elsewhere",
                        PersonKey = NullableText(stored, "personKey"),
                    }));
            }
            finally { await opened.DisposeAsync(); }
            Assert.True(HoldsFresh(storage.Get(joResource), "res-1") == row.GetProperty("saved").GetBoolean(), why);
        }
    }

    [Fact]
    public async Task ASignInChangedThroughWhatHoldsItKeepsOnlyARenewalsWrites()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var jo = Text(root.GetProperty("people").GetProperty("jo"), "personKey");
        var joResource = Text(PersonKeysRow(root, CaseKb, jo).GetProperty("cacheKeys"), "resource");
        var rows = root.GetProperty("holder").EnumerateArray().ToArray();
        Assert.NotEmpty(rows);
        foreach (var row in rows)
        {
            var why = Text(row, "why");
            var clock = new TestClock();
            var now = clock.GetUtcNow().ToUnixTimeSeconds();
            var storage = new MemoryStorage();
            RegistryStorage.StoreSession(storage, CaseKb, RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }), PersonKey = jo });
            using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
            gateway.Name(true);
            using var signals = new SessionSignals();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var opened = await new HttpSessionFactory(gateway.Http, clock)
                .OpenAsync(new SessionFactoryOptions(RegistryKb(CaseKb, "kb-a.test"), storage, signals, _ => { }), deadline.Token);
            try
            {
                Assert.Equal("fresh", (await opened.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(deadline.Token)).Name);
                Assert.True(storage.Get(joResource) is null, why + ": the client has not yet written what it holds");
                var holder = RegistryStorage.KeptIn(storage, CaseKb);
                var stored = row.GetProperty("stored");
                var access = TokenTests.Jwt(new { exp = now + 5400 });
                if (stored.ValueKind == JsonValueKind.Null) await holder.ForgetAsync(deadline.Token);
                else if (NullableText(stored, "personKey") == jo)
                {
                    var read = await holder.HeldAsync(deadline.Token) ?? throw new InvalidOperationException(why + ": nothing is held to renew");
                    Assert.True(await holder.RenewedAsync(read, access, "refresh renewed through the holder", deadline.Token) == access,
                        why + ": the holder keeps the renewal");
                }
                else
                {
                    await holder.KeepAsync(RegistryTokens() with
                    {
                        Access = access,
                        Refresh = "refresh kept through the holder",
                        PersonKey = NullableText(stored, "personKey"),
                    }, deadline.Token);
                }
            }
            finally { await opened.DisposeAsync(); }
            Assert.True(HoldsFresh(storage.Get(joResource), "res-1") == row.GetProperty("saved").GetBoolean(), why);
        }
    }

    [Theory]
    [InlineData("named")]
    [InlineData("unnamed")]
    [InlineData("none")]
    public async Task KeepingANewSignInForgetsWhatWasKeptForThePersonTheReplacedOneNamed(string signedIn)
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var jo = Text(root.GetProperty("people").GetProperty("jo"), "personKey");
        var seeded = Seeded(root, "forgetStorage");
        var storage = new MemoryStorage();
        foreach (var (key, value) in seeded) storage.Set(key, value);
        var replaced = signedIn switch
        {
            "named" => RegistryTokens() with { PersonKey = jo },
            "unnamed" => RegistryTokens(),
            "none" => null,
            var stated => throw new InvalidOperationException("No sign-in is " + stated),
        };
        if (replaced is not null) RegistryStorage.StoreSession(storage, CaseKb, replaced);
        await RegistryStorage.KeptIn(storage, CaseKb).KeepAsync(SigningIn());
        Assert.Equal(SigningIn(), RegistryStorage.StoredSession(storage, CaseKb));
        string[] removed = signedIn == "named" ? PersonKeys(PersonKeysRow(root, CaseKb, jo)) : [];
        foreach (var (key, value) in seeded)
            Assert.True(storage.Get(key) == (removed.Contains(key) ? null : value), signedIn + ": " + key + " holds " + (storage.Get(key) ?? "nothing"));
    }

    // The save passes the check and is held as it writes; the session's own forget of its sign-in runs while it is held,
    // waiting for it or not; once both have finished, nothing the forget deleted holds anything.
    [Fact]
    public async Task NoSaveLandsAfterTheSessionForgetsItsSignIn()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var jo = Text(root.GetProperty("people").GetProperty("jo"), "personKey");
        var joKeys = PersonKeysRow(root, CaseKb, jo);
        var joResource = Text(joKeys.GetProperty("cacheKeys"), "resource");
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var access = TokenTests.Jwt(new { exp = now + 3600 });
        var renewed = TokenTests.Jwt(new { exp = now + 7200 });
        using var storage = new HeldWriteStorage(joResource);
        RegistryStorage.StoreSession(storage, CaseKb, RegistryTokens() with { Access = access, PersonKey = jo });
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), renewed);
        gateway.Name(true);
        using var signals = new SessionSignals();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var opened = await new HttpSessionFactory(gateway.Http, clock)
            .OpenAsync(new SessionFactoryOptions(RegistryKb(CaseKb, "kb-a.test"), storage, signals, _ => { }), deadline.Token);
        try
        {
            var session = opened.Session ?? throw new InvalidOperationException("The registry's session holds no sign-in.");
            Assert.Equal("fresh", (await opened.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(deadline.Token)).Name);
            await clock.WaitForAsync(SaveDebounce);
            // The debounce's save runs on the thread that passes it, and is held there.
            var passing = Task.Run(() => clock.Advance(SaveDebounce), deadline.Token);
            await storage.Writing.Task.WaitAsync(deadline.Token);
            gateway.Refuse(access);
            gateway.Refuse(renewed);
            var refused = opened.Client.Transport.GetStatusAsync(deadline.Token);
            await foreach (var token in session.Token.WithCancellation(deadline.Token))
                if (token is null) break;
            // The session ending has begun its forget: unfixed, it deletes at once; fixed, it waits for the held save.
            await Task.WhenAny(storage.Deleted.Task, Task.Delay(TimeSpan.FromMilliseconds(500), deadline.Token));
            Assert.True(storage.Get(joResource) is null, "the save is still held, unwritten, when the session forgets its sign-in");
            storage.Release();
            await passing;
            await Assert.ThrowsAsync<TransportError>(() => refused);
            Assert.Equal(SessionEndReason.Refused, await EndedAsync(signals, deadline.Token));
            Assert.True(RegistryStorage.StoredSession(storage, CaseKb) is null, "the session forgot its sign-in");
        }
        finally
        {
            storage.Release();
            await opened.DisposeAsync();
        }
        foreach (var key in PersonKeys(joKeys)) Assert.True(storage.Get(key) is null, key + " holds " + storage.Get(key));
    }

    [Fact]
    public async Task ASignInThatCannotBeReadAsTheClientSavesEndsItsKeepingAndTellsTheSessionOnce()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var jo = Text(root.GetProperty("people").GetProperty("jo"), "personKey");
        var joKeys = PersonKeysRow(root, CaseKb, jo);
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var storage = new UnreadableSignInStorage(RegistryStorage.SessionKey(CaseKb));
        RegistryStorage.StoreSession(storage, CaseKb, RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }), PersonKey = jo });
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(true);
        using var signals = new SessionSignals();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var errors = Channel.CreateUnbounded<SessionError>();
        var opened = await new HttpSessionFactory(gateway.Http, clock)
            .OpenAsync(new SessionFactoryOptions(RegistryKb(CaseKb, "kb-a.test"), storage, signals, error => errors.Writer.TryWrite(error)), deadline.Token);
        try
        {
            var session = opened.Session ?? throw new InvalidOperationException("The registry's session holds no sign-in.");
            Assert.Equal("fresh", (await opened.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(deadline.Token)).Name);
            storage.Unreadable();
            await clock.WaitForAsync(SaveDebounce);
            clock.Advance(SaveDebounce);
            var told = await errors.Reader.ReadAsync(deadline.Token);
            Assert.Equal("session.keep-failed", told.Code);
            Assert.Contains(CaseKb, told.Message, StringComparison.Ordinal);
            Assert.IsType<IOException>(told.InnerException);
            Assert.Equal("fresh", (await opened.Client.Browse.Resource(ResourceId.Parse("res-2")).FreshAsync(deadline.Token)).Name);
            await clock.WaitForAsync(SaveDebounce);
            clock.Advance(SaveDebounce);
            Assert.True(session.Token.Value is not null, "the session goes on");
        }
        finally { await opened.DisposeAsync(); }
        var later = new List<SessionError>();
        while (errors.Reader.TryRead(out var error)) later.Add(error);
        Assert.DoesNotContain(later, error => error.Code == "session.keep-failed");
        foreach (var key in PersonKeys(joKeys)) Assert.True(storage.Get(key) is null, key + " holds " + storage.Get(key));
    }

    private static async Task ForgetCaseAsync(JsonElement root, JsonElement row)
    {
        var by = Text(row, "by");
        var why = by + ": " + Text(row, "why");
        var jo = Text(root.GetProperty("people").GetProperty("jo"), "personKey");
        var joKeys = PersonKeysRow(root, CaseKb, jo);
        var seeded = Seeded(root, "forgetStorage");
        string[] removed = Text(row, "removes") switch
        {
            "person" => PersonKeys(joKeys),
            "nothing" => [],
            var stated => throw new InvalidOperationException(why + ": forgetting removes no " + stated),
        };
        var storage = new ExternallyWritableStorage();
        foreach (var (key, value) in seeded) storage.Set(key, value);
        var signedIn = Text(row, "signedIn") switch
        {
            "named" => RegistryTokens() with { PersonKey = jo },
            "unnamed" => RegistryTokens(),
            "none" => null,
            var stated => throw new InvalidOperationException(why + ": no sign-in is " + stated),
        };
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        switch (by)
        {
            case "signOut" or "removal" or "signIn":
                await RegistryForgetsAsync(storage, signedIn, row, jo, Text(joKeys.GetProperty("cacheKeys"), "resource"), why, deadline.Token);
                break;
            case "expiry" or "refusal":
                await SessionForgetsAsync(root, storage, signedIn ?? throw new InvalidOperationException(why + ": a session needs a sign-in"),
                    row, why, deadline.Token);
                break;
            default: throw new InvalidOperationException(why + ": no sign-in is forgotten by " + by);
        }
        foreach (var (key, value) in seeded)
            Assert.True(storage.Get(key) == (removed.Contains(key) ? null : value), why + ": " + key + " holds " + (storage.Get(key) ?? "nothing"));
        if (by == "signIn") Assert.True(RegistryStorage.StoredSession(storage, CaseKb) == SigningIn(), why + ": the stored sign-in is the new one");
    }

    // A stand-in client of kb-a opened while its sign-in names jo writes under jo's resource key as it closes.
    private static async Task RegistryForgetsAsync(ExternallyWritableStorage storage, StoredSession? signedIn, JsonElement row,
        string jo, string joResource, string why, CancellationToken cancellation)
    {
        var open = row.GetProperty("open").GetBoolean();
        var forgetting = RegistryKb(CaseKb, "kb-a.test");
        var standing = RegistryKb("kb-b", "kb-b.test");
        RegistryStorage.SaveKnowledgeBases(storage, [forgetting, standing]);
        var active = open ? forgetting : standing;
        storage.Set(RegistryStorage.ActiveKey, active.Id);
        if (signedIn is not null) RegistryStorage.StoreSession(storage, forgetting.Id, signedIn);
        var factory = new RegistryFactory((options, _) => Task.FromResult(OpenRegistrySession(options.Kb,
            onClose: options.Kb.Id == forgetting.Id && RegistryStorage.StoredSession(options.Storage, options.Kb.Id)?.PersonKey == jo
                ? () => storage.Set(joResource, """{"version":1,"entries":[]}""") : null)));
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(storage, factory));
        await browser.SetActiveKbAsync(active.Id, cancellation);
        Assert.True(browser.State.ActiveSession is not null, why + ": " + active.Id + " is open");
        await (Text(row, "by") switch
        {
            "signOut" => browser.SignOutAsync(forgetting.Id, cancellation),
            "removal" => browser.RemoveKbAsync(forgetting.Id, cancellation),
            "signIn" => browser.SignInAsync(forgetting.Id, SigningIn(), cancellation),
            var by => throw new InvalidOperationException(why + ": the registry forgets no sign-in by " + by),
        });
    }

    /// <summary>A new sign-in: other tokens, and no person until its gateway names them.</summary>
    private static StoredSession SigningIn() => RegistryTokens() with { Access = "new access", Refresh = "new refresh" };

    private static async Task SessionForgetsAsync(JsonElement root, ExternallyWritableStorage storage, StoredSession signedIn, JsonElement row,
        string why, CancellationToken cancellation)
    {
        Assert.True(row.GetProperty("open").GetBoolean(), why + ": a session that ends is the open one");
        var by = Text(row, "by");
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var stored = Text(row, "stored");
        var access = TokenTests.Jwt(new
        {
            exp = stored switch
            {
                "expired" => now - 60,
                "unexpired" => now + 3600,
                var stated => throw new InvalidOperationException(why + ": no token is " + stated),
            },
        });
        RegistryStorage.StoreSession(storage, CaseKb, signedIn with { Access = access });
        var renewed = TokenTests.Jwt(new { exp = now + 7200 });
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), renewed);
        gateway.Name(true);
        if (by == "expiry") gateway.RefuseRenewal();
        using var signals = new SessionSignals();
        var opened = await new HttpSessionFactory(gateway.Http, clock)
            .OpenAsync(new SessionFactoryOptions(RegistryKb(CaseKb, "kb-a.test"), storage, signals, _ => { }), cancellation);
        try
        {
            if (stored == "unexpired")
            {
                // The debounce never fires on this clock, so the value waits for the client's close to be written.
                Assert.Equal("fresh", (await opened.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(cancellation)).Name);
                gateway.Refuse(access);
                gateway.Refuse(renewed);
                await Assert.ThrowsAsync<TransportError>(() => opened.Client.Transport.GetStatusAsync(cancellation));
                Assert.True(await EndedAsync(signals, cancellation) == (by == "refusal" ? SessionEndReason.Refused : SessionEndReason.Expired), why + ": how the session ended");
            }
            Assert.True(RegistryStorage.StoredSession(storage, CaseKb) is null, why + ": the session forgot its sign-in");
        }
        finally { await opened.DisposeAsync(); }
    }

    private static async Task<SessionEndReason> EndedAsync(SessionSignals signals, CancellationToken cancellation)
    {
        await foreach (var ended in signals.SessionEnded.WithCancellation(cancellation))
            if (ended is { Reason: var reason }) return reason;
        throw new InvalidOperationException("The session's signals closed before it ended.");
    }

    private static async Task StartupCaseAsync(JsonElement root, JsonElement row, bool namedLate)
    {
        var why = Text(row, "why") + (namedLate ? ", the gateway answering after the client is first asked" : ", the gateway answering as the session starts");
        var names = Text(row, "gateway") switch
        {
            "names" => true,
            "unreachable" => false,
            var other => throw new InvalidOperationException(why + ": no gateway " + other),
        };
        var kept = root.GetProperty("startupStorage").EnumerateObject()
            .ToDictionary(entry => entry.Name, entry => entry.Value.GetString() ?? throw new InvalidOperationException("Nothing kept under " + entry.Name));
        var storage = new ExternallyWritableStorage();
        foreach (var (key, value) in kept) storage.Set(key, value);
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var access = TokenTests.Jwt(new { exp = now + 3600 });
        var signedIn = RegistryTokens() with { Access = access };
        RegistryStorage.StoreSession(storage, CaseKb, Text(row, "signedIn") switch
        {
            "named" => signedIn with { PersonKey = Text(root.GetProperty("people").GetProperty("jo"), "personKey") },
            "unnamed" => signedIn,
            var other => throw new InvalidOperationException(why + ": no sign-in is " + other),
        });
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(names && !namedLate);
        using var signals = new SessionSignals();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var opened = await new HttpSessionFactory(gateway.Http)
            .OpenAsync(new SessionFactoryOptions(RegistryKb(CaseKb, "kb-a.test"), storage, signals, _ => { }), deadline.Token);
        try
        {
            var client = opened.Client;
            if (namedLate)
            {
                await using (var first = client.Browse.Resource(ResourceId.Parse("res-2")).GetAsyncEnumerator(deadline.Token))
                    Assert.True(await KeptOrFreshAsync(first) == Text(row, "first"), why + ": res-2, asked first");
                gateway.Name(names);
                gateway.Refuse(access);
                // A refused request is sent again only once its renewal's ask who the token is has been answered.
                await client.Transport.GetStatusAsync(deadline.Token);
            }
            Assert.True(RegistryStorage.StoredSession(storage, CaseKb)?.PersonKey == NullableText(row, "recorded"), why + ": the person recorded");
            await using var then = client.Browse.Resource(ResourceId.Parse("res-1")).GetAsyncEnumerator(deadline.Token);
            Assert.True(await KeptOrFreshAsync(then) == Text(row, "then"), why + ": res-1, asked then");
            Assert.True(await PlaceAsync(gateway.Server, "res-1", deadline.Token) == NullableText(row, "place"), why + ": res-1's place");
        }
        finally { await opened.DisposeAsync(); }
        if (!row.TryGetProperty("untouched", out var untouched) || !untouched.GetBoolean()) return;
        foreach (var (key, value) in kept) Assert.True(storage.Get(key) == value, why + ": " + key + " holds what it held");
        using var stored = ReadSpec("session/stored.json");
        string[] prefixes = [Text(stored.RootElement.GetProperty("cacheKeyPrefix"), "prefix"), Text(stored.RootElement.GetProperty("lastEventIdKeyPrefix"), "prefix")];
        var under = storage.Keys().Where(key => prefixes.Any(prefix => key.StartsWith(prefix, StringComparison.Ordinal))).ToHashSet(StringComparer.Ordinal);
        Assert.True(under.SetEquals(kept.Keys), why + ": nothing else is kept, but " + string.Join(", ", under.Except(kept.Keys)));
    }

    private static JsonElement PersonKeysRow(JsonElement root, string kbId, string personKey) =>
        root.GetProperty("keys").EnumerateArray().Single(row => Text(row, "kbId") == kbId && Text(row, "personKey") == personKey);

    /// <summary>Every key a keys row names: the stream's places and each persisted query's.</summary>
    private static string[] PersonKeys(JsonElement keysRow) =>
        [Text(keysRow, "lastEventIdKey"), .. keysRow.GetProperty("cacheKeys").EnumerateObject()
            .Select(key => key.Value.GetString() ?? throw new InvalidOperationException("No key for " + key.Name))];

    private static Dictionary<string, string> Seeded(JsonElement root, string part) =>
        root.GetProperty(part).EnumerateObject()
            .ToDictionary(entry => entry.Name, entry => entry.Value.GetString() ?? throw new InvalidOperationException("Nothing kept under " + entry.Name));

    private static string? NullableText(JsonElement row, string name) =>
        row.GetProperty(name).ValueKind == JsonValueKind.Null ? null : Text(row, name);

    private static async Task<string> KeptOrFreshAsync(IAsyncEnumerator<CacheState<ResourceDescriptor>> states)
    {
        string? first = null;
        while (await states.MoveNextAsync())
        {
            switch (states.Current)
            {
                case CacheState<ResourceDescriptor>.Failed(var error):
                    throw new InvalidOperationException("The read failed: " + error.Message, error);
                case CacheState<ResourceDescriptor>.Ready(var value):
                    first ??= value.Name;
                    if (value.Name == "fresh") return first;
                    break;
            }
        }
        throw new InvalidOperationException("The read ended before the gateway's answer.");
    }

    private static async Task<string?> PlaceAsync(Handler server, string scope, CancellationToken cancellation)
    {
        while (true)
        {
            var body = await server.Subscriptions.Reader.ReadAsync(cancellation);
            foreach (var scoped in body.GetProperty("scoped").EnumerateArray())
            {
                if (Text(scoped, "scope") != scope) continue;
                return scoped.TryGetProperty("lastEventId", out var id) && id.ValueKind == JsonValueKind.String ? id.GetString() : null;
            }
        }
    }

    private static bool HoldsFresh(string? document, string id)
    {
        if (document is null) return false;
        using var parsed = JsonDocument.Parse(document);
        Assert.Equal(1, parsed.RootElement.GetProperty("version").GetInt32());
        return parsed.RootElement.GetProperty("entries").EnumerateArray()
            .Any(entry => entry[0].GetString() == id && Text(entry[1], "name") == "fresh");
    }

    private static JsonObject Described(string id, string name) => new()
    {
        ["@context"] = "https://schema.org/",
        ["@id"] = id,
        ["name"] = name,
        ["representations"] = new JsonArray(),
    };

    private sealed class PersonGateway : IDisposable
    {
        private const string Status = """{"status":"ready","message":"ready","version":"1","features":{"semanticContent":"ready","collaboration":"ready"}}""";
        private volatile bool names;
        private volatile bool renewalRefused;
        private volatile string[] refused = [];

        internal PersonGateway(string whoAmI, string renewed)
        {
            Server.Answer = sent =>
            {
                Assert.Equal(BusOperations.BrowseResourceRequested.Request.Name, Text(sent, "channel"));
                Reply(Server, sent, BusOperations.BrowseResourceRequested.Result.Name,
                    new { response = new { resource = Described(Text(sent.GetProperty("payload"), "resourceId"), "fresh"), lastSequence = 1 } });
            };
            Server.Other = (request, _) => request.RequestUri?.AbsolutePath switch
            {
                "/api/users/me" => Refused(request) ? Answered(HttpStatusCode.Unauthorized, "{}")
                    : names ? Answered(HttpStatusCode.OK, whoAmI)
                    : Task.FromException<HttpResponseMessage>(new HttpRequestException("The gateway is unreachable.")),
                "/api/status" => Refused(request) ? Answered(HttpStatusCode.Unauthorized, "{}") : Answered(HttpStatusCode.OK, Status),
                "/token" => renewalRefused ? Answered(HttpStatusCode.BadRequest, """{"error":"invalid_grant"}""")
                    : Answered(HttpStatusCode.OK, JsonSerializer.Serialize(new { access_token = renewed, refresh_token = "renewed refresh" })),
                var path => throw new InvalidOperationException("Unexpected request to " + path),
            };
            Http = new HttpClient(Server);
        }

        internal Handler Server { get; } = new();
        internal HttpClient Http { get; }
        internal void Name(bool answer) => names = answer;
        internal void Refuse(string token) => refused = [.. refused, token];
        internal void RefuseRenewal() => renewalRefused = true;

        private bool Refused(HttpRequestMessage request) =>
            request.Headers.Authorization?.Parameter is { } bearer && refused.Contains(bearer);

        private static Task<HttpResponseMessage> Answered(HttpStatusCode status, string body) =>
            Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) });

        public void Dispose() => Http.Dispose();
    }

    /// <summary>
    /// A storage whose first write of one key waits, outside the storage's own lock, until the test releases it, and
    /// which tells when that write has begun and when the key is deleted.
    /// </summary>
    private sealed class HeldWriteStorage(string held) : ISessionStorage, IDisposable
    {
        private readonly MemoryStorage values = new();
        private readonly ManualResetEventSlim released = new();
        internal TaskCompletionSource Writing { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Deleted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal void Release() => released.Set();

        public string? Get(string key) => values.Get(key);

        public void Set(string key, string value)
        {
            if (key == held && Writing.TrySetResult() && !released.Wait(TimeSpan.FromSeconds(10)))
                throw new InvalidOperationException("The test never released the held write of " + key);
            values.Set(key, value);
        }

        public void Delete(string key)
        {
            values.Delete(key);
            if (key == held) Deleted.TrySetResult();
        }

        public void Update(string key, Func<string?, string?> change) => values.Update(key, change);
        public IDisposable? Subscribe(Action<string, string?> onChange) => null;
        public void Dispose() => released.Dispose();
    }

    /// <summary>A storage whose reads of one key fail once the test says so.</summary>
    private sealed class UnreadableSignInStorage(string unreadable) : ISessionStorage
    {
        private readonly MemoryStorage values = new();
        private volatile bool failing;
        internal void Unreadable() => failing = true;

        public string? Get(string key) =>
            failing && key == unreadable ? throw new IOException("The saved sign-in cannot be read.") : values.Get(key);

        public void Set(string key, string value) => values.Set(key, value);
        public void Delete(string key) => values.Delete(key);
        public void Update(string key, Func<string?, string?> change) => values.Update(key, change);
        public IDisposable? Subscribe(Action<string, string?> onChange) => null;
    }
}
