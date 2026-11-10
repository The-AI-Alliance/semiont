using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
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

// What a client keeps of one person, and when it is read, written and deleted, held to
// protocol/specs/src/session/persisted-cases.json, the table every SDK runs. A registry's session is
// HttpSessionFactory's, which opens once its start has asked who the token is: a gateway that names the
// person only after the client is first asked leaves the start's ask unanswered and names them on the ask a
// renewal makes, and every startup row runs again with the start's ask answered, where nothing is asked before.
// For the same reason a token found `expired` is forgotten by the start's refused renewal, before the factory
// makes the client; an `unexpired` one is refused once the client is open and holds a value it has not written.
// C#'s keeping session over a memory sign-in is the one SemiontSession.FromKeptAsync makes, so `holder` runs over
// one, its sign-in held apart from the storage its client keeps in.
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
            var holder = new MemorySignIn(RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }), PersonKey = jo });
            using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
            gateway.Name(true);
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await using (var opened = await SemiontSession.FromKeptAsync(Target(RegistryKb(CaseKb, "kb-a.test")), holder, storage, gateway.Http, clock,
                cancellation: deadline.Token))
            {
                var session = Assert.IsType<SemiontSession>(opened.Session);
                await session.ReadyAsync(deadline.Token);
                Assert.Equal("fresh", (await session.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(deadline.Token)).Name);
                Assert.True(storage.Get(joResource) is null, why + ": the client has not yet written what it holds");
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

    // B17 item 1: nothing is owed before the gateway names the person, and attaching writes nothing. What the client held
    // before then is written with its next change, whose save writes the whole document.
    [Fact]
    public async Task AttachingWritesNothingAndTheNextChangeWritesTheWholeDocument()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var jo = Text(root.GetProperty("people").GetProperty("jo"), "personKey");
        var joResource = Text(PersonKeysRow(root, CaseKb, jo).GetProperty("cacheKeys"), "resource");
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var access = TokenTests.Jwt(new { exp = now + 3600 });
        var storage = new MemoryStorage();
        RegistryStorage.StoreSession(storage, CaseKb, RegistryTokens() with { Access = access });
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        using var signals = new SessionSignals();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var opened = await new HttpSessionFactory(gateway.Http, clock)
            .OpenAsync(new SessionFactoryOptions(RegistryKb(CaseKb, "kb-a.test"), storage, signals, _ => { }), deadline.Token);
        try
        {
            var client = opened.Client;
            Assert.Equal("fresh", (await client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(deadline.Token)).Name);
            clock.Advance(SaveDebounce);
            gateway.Name(true);
            gateway.Refuse(access);
            // A refused request is sent again only once its renewal's ask who the token is has been answered.
            await client.Transport.GetStatusAsync(deadline.Token);
            Assert.True(RegistryStorage.StoredSession(storage, CaseKb)?.PersonKey == jo, "the gateway named jo");
            clock.Advance(SaveDebounce);
            Assert.True(storage.Get(joResource) is null, "attaching wrote what the client held before jo was named: " + storage.Get(joResource));

            Assert.Equal("fresh", (await client.Browse.Resource(ResourceId.Parse("res-2")).FreshAsync(deadline.Token)).Name);
            await clock.WaitForAsync(SaveDebounce);
            clock.Advance(SaveDebounce);
            await UntilAsync(() => storage.Get(joResource) is not null, deadline.Token);
            var written = storage.Get(joResource);
            Assert.True(HoldsFresh(written, "res-1") && HoldsFresh(written, "res-2"), "the next change's save writes the whole document: " + written);
        }
        finally { await opened.DisposeAsync(); }
    }

    // A script's session over a kept sign-in (C#'s sessionFromKept: SemiontSession.FromKeptAsync) takes a storage for the
    // caches, and its client keeps its persisted queries there for the person its gateway names, under the keys
    // stored.json gives that knowledge base and that person.
    [Fact]
    public async Task ASessionFromAKeptSignInKeepsItsPersistedQueriesInTheStorageItIsGiven()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var jo = Text(root.GetProperty("people").GetProperty("jo"), "personKey");
        var joResource = Text(PersonKeysRow(root, CaseKb, jo).GetProperty("cacheKeys"), "resource");
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var signIn = new MemorySignIn(RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }) });
        var storage = new MemoryStorage();
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(true);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var kb = RegistryKb(CaseKb, "kb-a.test");
        await using (var opened = await SemiontSession.FromKeptAsync(Target(kb), signIn, storage, gateway.Http, clock, cancellation: deadline.Token))
        {
            var session = Assert.IsType<SemiontSession>(opened.Session);
            await session.ReadyAsync(deadline.Token);
            Assert.Equal("fresh", (await session.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(deadline.Token)).Name);
            await clock.WaitForAsync(SaveDebounce);
            clock.Advance(SaveDebounce);
            await UntilAsync(() => storage.Get(joResource) is not null, deadline.Token);
        }
        Assert.True(HoldsFresh(storage.Get(joResource), "res-1"), "the session kept res-1 for jo: " + storage.Get(joResource));
    }

    // A session from a kept sign-in that already names its person is made knowing them (CACHE-SEMANTICS B17 item 1):
    // what is kept for them is in its client's caches from the start. This is the `startup` row whose sign-in names
    // its person, read first while the gateway has not named anyone, as that row's registry run reads it.
    [Fact]
    public async Task ASessionFromASignInThatNamesItsPersonHoldsWhatIsKeptForThemFromTheStart()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var row = root.GetProperty("startup").EnumerateArray().Single(each => Text(each, "signedIn") == "named");
        var why = Text(row, "why");
        var storage = new MemoryStorage();
        foreach (var entry in root.GetProperty("startupStorage").EnumerateObject())
            storage.Set(entry.Name, entry.Value.GetString() ?? throw new InvalidOperationException("Nothing kept under " + entry.Name));
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var holder = new MemorySignIn(RegistryTokens() with
        {
            Access = TokenTests.Jwt(new { exp = now + 3600 }),
            PersonKey = Text(root.GetProperty("people").GetProperty("jo"), "personKey"),
        });
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(false);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var opened = await SemiontSession.FromKeptAsync(Target(RegistryKb(CaseKb, "kb-a.test")), holder, storage, gateway.Http, clock,
            cancellation: deadline.Token);
        var session = Assert.IsType<SemiontSession>(opened.Session);
        await session.ReadyAsync(deadline.Token);
        await using var first = session.Client.Browse.Resource(ResourceId.Parse("res-2")).GetAsyncEnumerator(deadline.Token);
        Assert.True(await KeptOrFreshAsync(first) == Text(row, "first"), why + ": res-2, asked first");
    }

    // A session only uses its client, so it never ends it: whoever made the client and the session ends both, as ending
    // the opened session FromKeptAsync gives does.
    [Fact]
    public async Task DisposingASessionLeavesItsClientOpen()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(true);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var opened = await SemiontSession.FromKeptAsync(Target(RegistryKb(CaseKb, "kb-a.test")),
            new MemorySignIn(RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }) }), httpClient: gateway.Http,
            timeProvider: clock, cancellation: deadline.Token);
        try
        {
            var session = Assert.IsType<SemiontSession>(opened.Session);
            await session.ReadyAsync(deadline.Token);
            session.Dispose();
            Assert.True(opened.Client.State != ConnectionState.Closed, "the session's disposal ended its client");
        }
        finally { await opened.DisposeAsync(); }
        Assert.Equal(ConnectionState.Closed, opened.Client.State);
    }

    // The keep check reads the sign-in through what keeps it (ISignInKept.HeldAsync), as every SDK's does. One it cannot
    // read there ends the client's keeping, and the session says so once, on its errors stream, as session.keep-failed;
    // the session goes on.
    [Fact]
    public async Task ASignInItsKeeperCannotReadAsTheClientSavesEndsItsKeepingAndTellsTheSessionsErrorsOnce()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var jo = Text(root.GetProperty("people").GetProperty("jo"), "personKey");
        var joKeys = PersonKeysRow(root, CaseKb, jo);
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var signIn = new SignInUnreadableOnceTold(new MemorySignIn(RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }) }));
        var storage = new MemoryStorage();
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(true);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var kb = RegistryKb(CaseKb, "kb-a.test");
        var opened = await SemiontSession.FromKeptAsync(Target(kb), signIn, storage, gateway.Http, clock, cancellation: deadline.Token);
        var session = Assert.IsType<SemiontSession>(opened.Session);
        await session.ReadyAsync(deadline.Token);
        await using var errors = session.Errors(deadline.Token).GetAsyncEnumerator();
        var told = errors.MoveNextAsync().AsTask();
        Assert.Equal("fresh", (await session.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(deadline.Token)).Name);
        signIn.Unreadable();
        await clock.WaitForAsync(SaveDebounce);
        clock.Advance(SaveDebounce);
        Assert.True(await told.WaitAsync(deadline.Token), "the session's errors ended before it was told");
        Assert.Equal("session.keep-failed", errors.Current.Code);
        Assert.Contains(CaseKb, errors.Current.Message, StringComparison.Ordinal);
        Assert.IsType<IOException>(errors.Current.InnerException);
        Assert.Equal("fresh", (await session.Client.Browse.Resource(ResourceId.Parse("res-2")).FreshAsync(deadline.Token)).Name);
        await clock.WaitForAsync(SaveDebounce);
        clock.Advance(SaveDebounce);
        Assert.True(session.Token.Value is not null, "the session goes on");
        // Ending the opened session ends its client first, whose closing save meets the same unreadable sign-in while the
        // session's errors are still open.
        var later = errors.MoveNextAsync().AsTask();
        await opened.DisposeAsync();
        while (await later.WaitAsync(deadline.Token))
        {
            Assert.True(errors.Current.Code != "session.keep-failed", "the session was told twice that it keeps nothing more");
            later = errors.MoveNextAsync().AsTask();
        }
        foreach (var key in PersonKeys(joKeys)) Assert.True(storage.Get(key) is null, key + " holds " + storage.Get(key));
    }

    // The stream of what went wrong ends only after the disposal's flush (surface.json, the session unit's `errors`): a
    // closing save that cannot read the sign-in, read through a keeper that answers only after a wait, as a SignInStore's
    // locked file does, is told there as session.keep-failed, once, and the stream then ends. Ending the opened session
    // is waiting for that flush.
    [Fact]
    public async Task AClosingSaveThatCannotReadItsSignInIsSaidOnTheSessionsErrorsBeforeTheyEnd()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var joKeys = PersonKeysRow(root, CaseKb, Text(root.GetProperty("people").GetProperty("jo"), "personKey"));
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var signIn = new SignInReadLateOnceTold(new MemorySignIn(RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }) }));
        var storage = new MemoryStorage();
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(true);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var opened = await SemiontSession.FromKeptAsync(Target(RegistryKb(CaseKb, "kb-a.test")), signIn, storage, gateway.Http, clock,
            cancellation: deadline.Token);
        var session = Assert.IsType<SemiontSession>(opened.Session);
        await using IAsyncEnumerator<SemiontError> errors = session.Errors(deadline.Token).GetAsyncEnumerator();
        var told = errors.MoveNextAsync().AsTask();
        try
        {
            await session.ReadyAsync(deadline.Token);
            // The save res-1 owes waits for a debounce that never passes here: the disposal's flush is that save.
            Assert.Equal("fresh", (await session.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(deadline.Token)).Name);
            signIn.Unreadable();
            var closing = opened.DisposeAsync().AsTask();
            await signIn.Asked.Task.WaitAsync(deadline.Token);
            // Long enough for a disposal that does not wait for its flush to have ended the session's errors.
            await Task.WhenAny(told, Task.Delay(TimeSpan.FromMilliseconds(200), deadline.Token));
            if (told.IsCompleted) Assert.True(await told, "the session's errors ended while its closing save was still asking who its sign-in names");
            Assert.False(closing.IsCompleted, "ending the opened session did not wait for its closing save");
            signIn.Answer();
            await closing.WaitAsync(deadline.Token);
        }
        finally
        {
            signIn.Answer();
            await EndAsync(opened, told);
        }
        var said = await SaidUntilEndAsync(errors, told, deadline.Token);
        Assert.True(said.Count(error => error.Code == "session.keep-failed") == 1,
            "the session's errors ended without the closing save's keep-failed said once: [" + string.Join(", ", said.Select(error => error.Code)) + "]");
        Assert.Same(signIn.Failure, said.Single(error => error.Code == "session.keep-failed").InnerException);
        foreach (var key in PersonKeys(joKeys)) Assert.True(storage.Get(key) is null, key + " holds " + storage.Get(key));
    }

    // A sign-in that cannot record the person the gateway named is session.keep-failed (protocol/specs/src/errors/codes.json),
    // said once on the session's errors stream, and the session goes on signed in. A later ask who a renewed token is says
    // nothing more.
    [Fact]
    public async Task ASignInThatCannotRecordWhoTheGatewayNamedIsSaidOnTheSessionsErrorsOnceAndTheSessionGoesOn()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var access = TokenTests.Jwt(new { exp = now + 3600 });
        var signIn = new SignInThatCannotRecord(new MemorySignIn(RegistryTokens() with { Access = access }));
        var storage = new MemoryStorage();
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(true);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var opened = await SemiontSession.FromKeptAsync(Target(RegistryKb(CaseKb, "kb-a.test")), signIn, storage, gateway.Http, clock,
            cancellation: deadline.Token);
        var session = Assert.IsType<SemiontSession>(opened.Session);
        await using IAsyncEnumerator<SemiontError> errors = session.Errors(deadline.Token).GetAsyncEnumerator();
        var told = errors.MoveNextAsync().AsTask();
        try
        {
            await session.ReadyAsync(deadline.Token);
            Assert.True(session.User.Value is not null, "the session goes on: the person the gateway named is signed in");
            Assert.Equal(access, session.Token.Value);
            gateway.Refuse(access);
            await session.Client.Transport.GetStatusAsync(deadline.Token);
            Assert.True((await signIn.HeldAsync(deadline.Token))?.Access is { } renewed && renewed != access, "the refused token was renewed");
        }
        finally { await EndAsync(opened, told); }
        var said = await SaidUntilEndAsync(errors, told, deadline.Token);
        Assert.True(said.Count(error => error.Code == "session.keep-failed") == 1,
            "the sign-in that could not record its person was not said once: [" + string.Join(", ", said.Select(error => error.Code)) + "]");
        Assert.Same(signIn.Failure, said.Single(error => error.Code == "session.keep-failed").InnerException);
    }

    // A session's errors are its one stream of what went wrong (surface.json, the session unit's `errors`): its transport's
    // failures are said there too, each once.
    [Fact]
    public async Task ATransportFailureIsSaidOnTheSessionsErrorsOnce()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(true);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var opened = await SemiontSession.FromKeptAsync(Target(RegistryKb(CaseKb, "kb-a.test")),
            new MemorySignIn(RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }) }), httpClient: gateway.Http,
            timeProvider: clock, cancellation: deadline.Token);
        var session = Assert.IsType<SemiontSession>(opened.Session);
        await using IAsyncEnumerator<SemiontError> errors = session.Errors(deadline.Token).GetAsyncEnumerator();
        var told = errors.MoveNextAsync().AsTask();
        await using var failures = session.Client.Transport.Errors(deadline.Token).GetAsyncEnumerator();
        var failed = failures.MoveNextAsync().AsTask();
        SemiontError met;
        try
        {
            await session.ReadyAsync(deadline.Token);
            // The stream is open once a read has been answered through it.
            Assert.Equal("fresh", (await session.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(deadline.Token)).Name);
            using (session.Client.Transport.On("beckon:focus", _ => throw new InvalidOperationException("The reader failed.")))
            {
                gateway.Server.Stream.Push("event: bus-event\ndata: {\"channel\":\"beckon:focus\",\"payload\":{\"resourceId\":\"res-1\",\"annotationId\":\"a-1\"}}\n\n");
                Assert.True(await failed.WaitAsync(deadline.Token), "the transport met no failure");
            }
            met = failures.Current;
        }
        finally
        {
            await EndAsync(opened, told);
            await Task.WhenAny(failed);
        }
        var said = await SaidUntilEndAsync(errors, told, deadline.Token);
        Assert.True(said.Count(error => ReferenceEquals(error, met)) == 1,
            "the transport's failure was not said once on the session's errors: [" + string.Join(", ", said.Select(error => error.Code)) + "]");
    }

    // At the start, a sign-in that cannot be read reaches whoever makes the session, as its failure, whether or not the
    // session's client keeps anything.
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ASignInThatCannotBeReadAtTheStartReachesWhoeverMakesTheSession(bool keeps)
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var signIn = new SignInUnreadableAfter(new MemorySignIn(RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }) }), reads: 0);
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(true);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        IOException? thrown = null;
        try
        {
            var opened = await SemiontSession.FromKeptAsync(Target(RegistryKb(CaseKb, "kb-a.test")), signIn, keeps ? new MemoryStorage() : null,
                gateway.Http, clock, cancellation: deadline.Token);
            await opened.DisposeAsync();
        }
        catch (IOException error) { thrown = error; }
        Assert.Same(signIn.Failure, thrown);
    }

    // A write the storage refuses is said on the session's errors once, as session.save-refused, with what the storage said
    // (protocol/specs/src/errors/codes.json); its save stays owed, and the client's closing writes it.
    [Fact]
    public async Task AWriteTheStorageRefusesIsSaidOnTheSessionsErrorsOnceAndItsSaveStaysOwed()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var jo = Text(root.GetProperty("people").GetProperty("jo"), "personKey");
        var joResource = Text(PersonKeysRow(root, CaseKb, jo).GetProperty("cacheKeys"), "resource");
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var storage = new RefusingStorage(joResource, refusals: 1);
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(true);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var opened = await SemiontSession.FromKeptAsync(Target(RegistryKb(CaseKb, "kb-a.test")),
            new MemorySignIn(RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }) }), storage, gateway.Http, clock,
            cancellation: deadline.Token);
        var session = Assert.IsType<SemiontSession>(opened.Session);
        await using IAsyncEnumerator<SemiontError> errors = session.Errors(deadline.Token).GetAsyncEnumerator();
        var told = errors.MoveNextAsync().AsTask();
        try
        {
            await session.ReadyAsync(deadline.Token);
            Assert.Equal("fresh", (await session.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(deadline.Token)).Name);
            await clock.WaitForAsync(SaveDebounce);
            clock.Advance(SaveDebounce);
            await UntilAsync(() => storage.Refused == 1, deadline.Token);
            Assert.True(storage.Get(joResource) is null, "the storage kept the write it refused: " + storage.Get(joResource));
        }
        finally { await EndAsync(opened, told); }
        var said = await SaidUntilEndAsync(errors, told, deadline.Token);
        var refused = said.Where(error => error.Code == "session.save-refused").ToArray();
        Assert.True(refused.Length == 1, "the refused write was not said once: [" + string.Join(", ", said.Select(error => error.Code)) + "]");
        Assert.Same(storage.Refusal, refused[0].InnerException);
        Assert.Contains(storage.Refusal.Message, refused[0].Message, StringComparison.Ordinal);
        Assert.True(HoldsFresh(storage.Get(joResource), "res-1"), "the closing did not write the save the storage refused: " + storage.Get(joResource));
    }

    // A write the client's closing cannot make is lost, and its refusal is said once on the session's errors, before they end.
    [Fact]
    public async Task AClosingWriteTheStorageRefusesIsSaidOnTheSessionsErrorsOnceBeforeTheyEnd()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var jo = Text(root.GetProperty("people").GetProperty("jo"), "personKey");
        var joResource = Text(PersonKeysRow(root, CaseKb, jo).GetProperty("cacheKeys"), "resource");
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var storage = new RefusingStorage(joResource, refusals: int.MaxValue);
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(true);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var opened = await SemiontSession.FromKeptAsync(Target(RegistryKb(CaseKb, "kb-a.test")),
            new MemorySignIn(RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }) }), storage, gateway.Http, clock,
            cancellation: deadline.Token);
        var session = Assert.IsType<SemiontSession>(opened.Session);
        await using IAsyncEnumerator<SemiontError> errors = session.Errors(deadline.Token).GetAsyncEnumerator();
        var told = errors.MoveNextAsync().AsTask();
        try
        {
            await session.ReadyAsync(deadline.Token);
            // The save res-1 owes waits for a debounce that never passes here: the closing's flush is that save.
            Assert.Equal("fresh", (await session.Client.Browse.Resource(ResourceId.Parse("res-1")).FreshAsync(deadline.Token)).Name);
        }
        finally { await EndAsync(opened, told); }
        var said = await SaidUntilEndAsync(errors, told, deadline.Token);
        var refused = said.Where(error => error.Code == "session.save-refused").ToArray();
        Assert.True(refused.Length == 1, "the closing's refused write was not said once: [" + string.Join(", ", said.Select(error => error.Code)) + "]");
        Assert.Same(storage.Refusal, refused[0].InnerException);
        Assert.Equal(1, storage.Refused);
        Assert.True(storage.Get(joResource) is null, "the storage kept the write it refused: " + storage.Get(joResource));
    }

    // A session opened over a kept sign-in asks the gateway who its token is, and so learns the person whose caches its
    // client keeps, unless it is told not to (protocol/specs/src/client/surface.json, the kept sign-in's docs): validate is
    // true when it is left out.
    [Theory]
    [InlineData(null)]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ASessionOverAKeptSignInAsksWhoItsTokenIsUnlessToldNotTo(bool? validate)
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var access = TokenTests.Jwt(new { exp = now + 3600 });
        var signIn = new MemorySignIn(RegistryTokens() with { Access = access });
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(true);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var kb = Target(RegistryKb(CaseKb, "kb-a.test"));
        await using var opened = validate is { } told
            ? await SemiontSession.FromKeptAsync(kb, signIn, httpClient: gateway.Http, timeProvider: clock, validate: told, cancellation: deadline.Token)
            : await SemiontSession.FromKeptAsync(kb, signIn, httpClient: gateway.Http, timeProvider: clock, cancellation: deadline.Token);
        var session = Assert.IsType<SemiontSession>(opened.Session);
        await session.ReadyAsync(deadline.Token);
        var asks = validate is false ? 0 : 1;
        Assert.True(gateway.Asks == asks, "the gateway was asked who the token is " + gateway.Asks + " times, not " + asks);
        Assert.Equal(access, session.Token.Value);
        Assert.True((session.User.Value is not null) == (asks == 1), "who is signed in is whoever the gateway was asked to name");
    }

    // A session told not to ask still keeps for the person its kept sign-in names, from the start, as the `startup` row whose
    // sign-in names its person has it (protocol/specs/src/client/surface.json, the kept sign-in's docs); asking is how a
    // session learns the person when the sign-in names nobody, so one that names nobody keeps for nobody, and records no one.
    [Theory]
    [InlineData("named")]
    [InlineData("unnamed")]
    public async Task ASessionToldNotToAskKeepsForThePersonItsSignInNamesAndForNobodyElse(string signedIn)
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var row = root.GetProperty("startup").EnumerateArray().First(each => Text(each, "signedIn") == signedIn);
        var why = Text(row, "why");
        var storage = new MemoryStorage();
        foreach (var entry in root.GetProperty("startupStorage").EnumerateObject())
            storage.Set(entry.Name, entry.Value.GetString() ?? throw new InvalidOperationException("Nothing kept under " + entry.Name));
        var clock = new TestClock();
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var named = signedIn == "named" ? Text(root.GetProperty("people").GetProperty("jo"), "personKey") : null;
        var holder = new MemorySignIn(RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }), PersonKey = named });
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(true);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var opened = await SemiontSession.FromKeptAsync(Target(RegistryKb(CaseKb, "kb-a.test")), holder, storage, gateway.Http, clock,
            validate: false, cancellation: deadline.Token);
        var session = Assert.IsType<SemiontSession>(opened.Session);
        await session.ReadyAsync(deadline.Token);
        await using var first = session.Client.Browse.Resource(ResourceId.Parse("res-2")).GetAsyncEnumerator(deadline.Token);
        Assert.True(await KeptOrFreshAsync(first) == Text(row, "first"), why + ": res-2, asked first");
        Assert.True(gateway.Asks == 0, why + ": the gateway was asked who the token is " + gateway.Asks + " times");
        Assert.True((await holder.HeldAsync(deadline.Token))?.PersonKey == named, why + ": the sign-in names someone else now");
    }

    /// <summary>Ends <paramref name="opened"/>, and waits for <paramref name="reading"/>, a read of its session's errors, to
    /// finish however it does: an enumerator cannot be disposed while a read is under way.</summary>
    private static async Task EndAsync(OpenedSession opened, Task<bool> reading)
    {
        await opened.DisposeAsync();
        await Task.WhenAny(reading);
    }

    /// <summary>What <paramref name="errors"/> says from <paramref name="next"/>, its read under way, until it ends.</summary>
    private static async Task<List<SemiontError>> SaidUntilEndAsync(IAsyncEnumerator<SemiontError> errors, Task<bool> next,
        CancellationToken cancellation)
    {
        var said = new List<SemiontError>();
        while (await next.WaitAsync(cancellation))
        {
            said.Add(errors.Current);
            next = errors.MoveNextAsync().AsTask();
        }
        return said;
    }

    public static IEnumerable<object[]> ResumeFromCases()
    {
        using var table = ReadSpec(PersistedCases);
        foreach (var row in table.RootElement.GetProperty("resumeFrom").EnumerateArray()) yield return [Text(row, "why")];
    }

    // `resumeFrom`: kb-a's client, kept for jo, holds res-1; the stream delivers the row's frames on res-1's scope, and
    // another scope taken then reopens it, naming the place res-1 resumes from.
    [Theory]
    [MemberData(nameof(ResumeFromCases))]
    public async Task AScopeResumesFromItsLastPersistedEventId(string why)
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var row = root.GetProperty("resumeFrom").EnumerateArray().Single(entry => Text(entry, "why") == why);
        var jo = Text(root.GetProperty("people").GetProperty("jo"), "personKey");
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var storage = new MemoryStorage();
        RegistryStorage.StoreSession(storage, CaseKb, RegistryTokens() with { Access = TokenTests.Jwt(new { exp = now + 3600 }), PersonKey = jo });
        using var gateway = new PersonGateway(root.GetProperty("whoAmI").GetRawText(), TokenTests.Jwt(new { exp = now + 7200 }));
        gateway.Name(true);
        using var signals = new SessionSignals();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var opened = await new HttpSessionFactory(gateway.Http)
            .OpenAsync(new SessionFactoryOptions(RegistryKb(CaseKb, "kb-a.test"), storage, signals, _ => { }), deadline.Token);
        try
        {
            var client = opened.Client;
            await using var held = client.Browse.Resource(ResourceId.Parse("res-1")).GetAsyncEnumerator(deadline.Token);
            Assert.Equal("fresh", await KeptOrFreshAsync(held));
            Assert.True(await PlaceAsync(gateway.Server, "res-1", deadline.Token) is null, why + ": nothing is kept for res-1's scope before");
            await using (var heard = client.Transport.Frames(BusChannels.MarkArchived.Name, deadline.Token).GetAsyncEnumerator())
            {
                foreach (var frame in row.GetProperty("frames").EnumerateArray())
                {
                    var id = frame.GetString() ?? throw new InvalidOperationException(why + ": a frame names no id");
                    var arrived = heard.MoveNextAsync().AsTask();
                    gateway.Server.Stream.Push("event: bus-event\nid: " + id + "\ndata: {\"channel\":\"" + BusChannels.MarkArchived.Name +
                        "\",\"scope\":\"res-1\",\"payload\":{}}\n\n");
                    Assert.True(await arrived.WaitAsync(deadline.Token), why + ": the stream ended before " + id);
                    Assert.Equal(id, Assert.IsType<ReceivedBusFrame>(heard.Current).EventId);
                }
            }
            await using var other = client.Browse.Resource(ResourceId.Parse("res-2")).GetAsyncEnumerator(deadline.Token);
            Assert.Equal("fresh", await KeptOrFreshAsync(other));
            Assert.True(await PlaceAsync(gateway.Server, "res-1", deadline.Token) == NullableText(row, "resumes"), why);
        }
        finally { await opened.DisposeAsync(); }
    }

    private static KbTarget Target(KnowledgeBase kb) => new() { Id = kb.Id, Label = kb.Label, Endpoint = kb.Endpoint };

    private static async Task UntilAsync(Func<bool> condition, CancellationToken cancellation)
    {
        while (!condition()) await Task.Delay(1, cancellation);
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
        private int asks;

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
                "/api/users/me" => WhoIs(request, whoAmI),
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

        /// <summary>How many times the gateway has been asked who a token is.</summary>
        internal int Asks => Volatile.Read(ref asks);

        private Task<HttpResponseMessage> WhoIs(HttpRequestMessage request, string whoAmI)
        {
            Interlocked.Increment(ref asks);
            return Refused(request) ? Answered(HttpStatusCode.Unauthorized, "{}")
                : names ? Answered(HttpStatusCode.OK, whoAmI)
                : Task.FromException<HttpResponseMessage>(new HttpRequestException("The gateway is unreachable."));
        }

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

    /// <summary>A sign-in kept in memory whose keeper cannot read it once the test says so.</summary>
    private sealed class SignInUnreadableOnceTold(MemorySignIn kept) : ISignInKept
    {
        private volatile bool failing;
        internal void Unreadable() => failing = true;

        public Task<StoredSession?> HeldAsync(CancellationToken cancellation = default) =>
            failing ? Task.FromException<StoredSession?>(new IOException("The kept sign-in cannot be read.")) : kept.HeldAsync(cancellation);

        public Task KeepAsync(StoredSession signIn, CancellationToken cancellation = default) => kept.KeepAsync(signIn, cancellation);
        public Task<string?> RenewedAsync(StoredSession read, string access, string refresh, CancellationToken cancellation = default) =>
            kept.RenewedAsync(read, access, refresh, cancellation);
        public Task ForgetAsync(CancellationToken cancellation = default) => kept.ForgetAsync(cancellation);
        public Task<bool> RecordPersonKeyAsync(string access, string personKey, CancellationToken cancellation = default) =>
            kept.RecordPersonKeyAsync(access, personKey, cancellation);
    }

    /// <summary>
    /// A sign-in kept in memory whose keeper, once the test says so, answers a read only when the test lets it, and then
    /// fails it with <see cref="Failure"/>; it tells when the first such read is asked.
    /// </summary>
    private sealed class SignInReadLateOnceTold(MemorySignIn kept) : ISignInKept
    {
        private readonly TaskCompletionSource answered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private volatile bool late;
        internal TaskCompletionSource Asked { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal IOException Failure { get; } = new("The kept sign-in cannot be read.");
        internal void Unreadable() => late = true;
        internal void Answer() => answered.TrySetResult();

        public Task<StoredSession?> HeldAsync(CancellationToken cancellation = default) =>
            late ? FailedLateAsync(cancellation) : kept.HeldAsync(cancellation);

        private async Task<StoredSession?> FailedLateAsync(CancellationToken cancellation)
        {
            Asked.TrySetResult();
            await answered.Task.WaitAsync(cancellation).ConfigureAwait(false);
            throw Failure;
        }

        public Task KeepAsync(StoredSession signIn, CancellationToken cancellation = default) => kept.KeepAsync(signIn, cancellation);
        public Task<string?> RenewedAsync(StoredSession read, string access, string refresh, CancellationToken cancellation = default) =>
            kept.RenewedAsync(read, access, refresh, cancellation);
        public Task ForgetAsync(CancellationToken cancellation = default) => kept.ForgetAsync(cancellation);
        public Task<bool> RecordPersonKeyAsync(string access, string personKey, CancellationToken cancellation = default) =>
            kept.RecordPersonKeyAsync(access, personKey, cancellation);
    }

    /// <summary>A sign-in kept in memory that cannot record the person the gateway named: each recording fails with
    /// <see cref="Failure"/>.</summary>
    private sealed class SignInThatCannotRecord(MemorySignIn kept) : ISignInKept
    {
        internal IOException Failure { get; } = new("The person the gateway named cannot be recorded.");

        public Task<StoredSession?> HeldAsync(CancellationToken cancellation = default) => kept.HeldAsync(cancellation);
        public Task KeepAsync(StoredSession signIn, CancellationToken cancellation = default) => kept.KeepAsync(signIn, cancellation);
        public Task<string?> RenewedAsync(StoredSession read, string access, string refresh, CancellationToken cancellation = default) =>
            kept.RenewedAsync(read, access, refresh, cancellation);
        public Task ForgetAsync(CancellationToken cancellation = default) => kept.ForgetAsync(cancellation);
        public Task<bool> RecordPersonKeyAsync(string access, string personKey, CancellationToken cancellation = default) =>
            Task.FromException<bool>(Failure);
    }

    /// <summary>A storage in memory that refuses the first <paramref name="refusals"/> writes of <paramref name="refused"/>,
    /// each with <see cref="Refusal"/>, as a host's storage that cannot write does.</summary>
    private sealed class RefusingStorage(string refused, int refusals) : ISessionStorage
    {
        private readonly MemoryStorage values = new();
        private int left = refusals;
        private int made;
        internal IOException Refusal { get; } = new("The storage cannot write " + refused);

        /// <summary>How many writes the storage has refused.</summary>
        internal int Refused => Volatile.Read(ref made);

        public string? Get(string key) => values.Get(key);

        public void Set(string key, string value)
        {
            if (key == refused && Interlocked.Decrement(ref left) >= 0)
            {
                Interlocked.Increment(ref made);
                throw Refusal;
            }
            values.Set(key, value);
        }

        public void Delete(string key) => values.Delete(key);
        public void Update(string key, Func<string?, string?> change) => values.Update(key, change);
        public IDisposable? Subscribe(Action<string, string?> onChange) => null;
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
