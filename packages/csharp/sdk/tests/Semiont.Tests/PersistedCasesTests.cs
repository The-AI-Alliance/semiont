using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Semiont.Identifiers;
using Semiont.Registry;
using Semiont.State;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

// What a client keeps of one person, and when it is read, written and deleted, held to
// protocol/specs/src/session/persisted-cases.json, the table every SDK runs. A registry's session is
// HttpSessionFactory's, which opens once its start has asked who the token is: a gateway that names the
// person only after the client is first asked leaves the start's ask unanswered and names them on the ask a
// renewal makes, and every startup row runs again with the start's ask answered, where nothing is asked before.
public sealed partial class TransportTests
{
    private const string PersistedCases = "session/persisted-cases.json";
    private const string CaseKb = "kb-a";

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
    public async Task SigningOutDeletesWhatIsKeptForThePersonItsSignInNames()
    {
        using var table = ReadSpec(PersistedCases);
        var root = table.RootElement;
        var rows = root.GetProperty("signOut").EnumerateArray().ToArray();
        Assert.NotEmpty(rows);
        foreach (var row in rows) await SignOutCaseAsync(root, row);
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

    private static async Task SignOutCaseAsync(JsonElement root, JsonElement row)
    {
        var why = Text(row, "why");
        var jo = Text(root.GetProperty("people").GetProperty("jo"), "personKey");
        var joKeys = PersonKeysRow(root, CaseKb, jo);
        var seeded = root.GetProperty("signOutStorage").EnumerateObject()
            .ToDictionary(entry => entry.Name, entry => entry.Value.GetString() ?? throw new InvalidOperationException("Nothing kept under " + entry.Name));
        string[] removed = Text(row, "removes") switch
        {
            "person" => [Text(joKeys, "lastEventIdKey"), .. joKeys.GetProperty("cacheKeys").EnumerateObject()
                .Select(key => key.Value.GetString() ?? throw new InvalidOperationException("No key for " + key.Name))],
            "nothing" => [],
            var stated => throw new InvalidOperationException(why + ": a sign-out removes no " + stated),
        };
        var open = row.GetProperty("open").GetBoolean();
        var storage = new ExternallyWritableStorage();
        foreach (var (key, value) in seeded) storage.Set(key, value);
        var signingOut = RegistryKb(CaseKb, "kb-a.test");
        var standing = RegistryKb("kb-b", "kb-b.test");
        RegistryStorage.SaveKnowledgeBases(storage, [signingOut, standing]);
        var active = open ? signingOut : standing;
        storage.Set(RegistryStorage.ActiveKey, active.Id);
        var signedIn = Text(row, "signedIn") switch
        {
            "named" => RegistryTokens() with { PersonKey = jo },
            "unnamed" => RegistryTokens(),
            "none" => null,
            var stated => throw new InvalidOperationException(why + ": no sign-in is " + stated),
        };
        if (signedIn is not null) RegistryStorage.StoreSession(storage, signingOut.Id, signedIn);
        var joResource = Text(joKeys.GetProperty("cacheKeys"), "resource");
        var factory = new RegistryFactory((options, _) => Task.FromResult(OpenRegistrySession(options.Kb,
            onClose: options.Kb.Id == signingOut.Id ? () => storage.Set(joResource, """{"version":1,"writtenAt":1700000000001,"entries":[]}""") : null)));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(storage, factory));
        await browser.SetActiveKbAsync(active.Id, deadline.Token);
        Assert.True(browser.State.ActiveSession is not null, why + ": " + active.Id + " is open");
        await browser.SignOutAsync(signingOut.Id, deadline.Token);
        foreach (var (key, value) in seeded)
            Assert.True(storage.Get(key) == (removed.Contains(key) ? null : value), why + ": " + key + " holds " + (storage.Get(key) ?? "nothing"));
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
        Assert.Equal(JsonValueKind.Number, parsed.RootElement.GetProperty("writtenAt").ValueKind);
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
        private volatile string? refused;

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
                "/api/users/me" => names ? Answered(HttpStatusCode.OK, whoAmI)
                    : Task.FromException<HttpResponseMessage>(new HttpRequestException("The gateway is unreachable.")),
                "/api/status" => request.Headers.Authorization?.Parameter == refused
                    ? Answered(HttpStatusCode.Unauthorized, "{}") : Answered(HttpStatusCode.OK, Status),
                "/token" => Answered(HttpStatusCode.OK, JsonSerializer.Serialize(new { access_token = renewed, refresh_token = "renewed refresh" })),
                var path => throw new InvalidOperationException("Unexpected request to " + path),
            };
            Http = new HttpClient(Server);
        }

        internal Handler Server { get; } = new();
        internal HttpClient Http { get; }
        internal void Name(bool answer) => names = answer;
        internal void Refuse(string token) => refused = token;

        private static Task<HttpResponseMessage> Answered(HttpStatusCode status, string body) =>
            Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) });

        public void Dispose() => Http.Dispose();
    }
}
