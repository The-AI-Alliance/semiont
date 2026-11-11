using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Semiont.Authorization;
using Semiont.Discovery;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Registry;
using Semiont.SignIn;
using Semiont.Storage;
using Semiont.State;
using Semiont.Testing;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed partial class TransportTests
{
    [Fact]
    public void RegistryStorageKeysAndSessionShapeFollowTheirTable()
    {
        using var table = ReadSpec("session/stored.json");
        var keys = new Dictionary<string, string>
        {
            ["knowledgeBasesKey"] = RegistryStorage.KnowledgeBasesKey,
            ["activeKey"] = RegistryStorage.ActiveKey,
            ["openResourcesByKbKey"] = RegistryStorage.OpenResourcesByKbKey,
            ["lastViewedResourceByKbKey"] = RegistryStorage.LastViewedResourceByKbKey,
            ["pendingAuthorizationKey"] = RedirectSignIn.PendingAuthorizationKey,
        };
        Assert.Equal(keys.Count, table.RootElement.GetProperty("keys").GetArrayLength());
        foreach (var row in table.RootElement.GetProperty("keys").EnumerateArray())
            Assert.Equal(Text(row, "key"), keys[Text(row, "member")]);

        var key = RegistryStorage.SessionKey("kb-1");
        Assert.Equal(Text(table.RootElement.GetProperty("sessionKeyPrefix"), "prefix") + "kb-1", key);
        Assert.Equal("kb-1", RegistryStorage.KbOfSessionKey(key));
        Assert.Null(RegistryStorage.KbOfSessionKey("unrelated"));
        var lastEventIdPrefix = table.RootElement.GetProperty("lastEventIdKeyPrefix");
        var lastEventIdExample = lastEventIdPrefix.GetProperty("example");
        var lastEventIdKey = RegistryStorage.LastEventIdKey(Text(lastEventIdExample, "kbId"), PersonKeyOf(lastEventIdExample));
        Assert.Equal(Text(lastEventIdExample, "key"), lastEventIdKey);
        Assert.StartsWith(Text(lastEventIdPrefix, "prefix"), lastEventIdKey, StringComparison.Ordinal);
        var cachePrefix = table.RootElement.GetProperty("cacheKeyPrefix");
        var cacheExample = cachePrefix.GetProperty("example");
        var cacheKey = RegistryStorage.CacheKey(Text(cacheExample, "kbId"), PersonKeyOf(cacheExample), Text(cacheExample, "query"));
        Assert.Equal(Text(cacheExample, "key"), cacheKey);
        Assert.StartsWith(Text(cachePrefix, "prefix"), cacheKey, StringComparison.Ordinal);
        // The one kept list: the queries client/refresh.json marks persisted.
        using var refresh = ReadSpec("client/refresh.json");
        var persisted = refresh.RootElement.GetProperty("queries").EnumerateArray()
            .Where(row => row.TryGetProperty("persisted", out var marked) && marked.GetBoolean()).Select(row => Text(row, "name")).ToArray();
        Assert.Equal(persisted, LiveQueries.PersistedQueries);
        Assert.Equal(Text(table.RootElement.GetProperty("wholeKey"), "key"), KeptTable.WholeKey);
        var document = table.RootElement.GetProperty("cacheDocument");
        Assert.Equal(document.GetProperty("properties").GetProperty("version").GetProperty("const").GetInt64(), KeptTable.Version);
        Assert.Equal(new[] { "version", "entries" }, document.GetProperty("required").EnumerateArray().Select(member => Assert.IsType<string>(member.GetString())));
        var places = table.RootElement.GetProperty("lastEventIds");
        Assert.EndsWith("/ResourceId.json", Text(places.GetProperty("propertyNames"), "$ref"), StringComparison.Ordinal);
        Assert.EndsWith("/PersistedEventId.json", Text(places.GetProperty("additionalProperties"), "$ref"), StringComparison.Ordinal);
        var store = new MemoryStorage();
        var session = RegistryTokens() with { RevocationEndpoint = "https://issuer.test/revoke", PersonKey = PersonKeyOf(cacheExample) };
        RegistryStorage.StoreSession(store, "kb-1", session);
        Assert.Equal(session, RegistryStorage.StoredSession(store, "kb-1"));
        var schema = table.RootElement.GetProperty("storedSession");
        var text = Assert.IsType<string>(store.Get(key));
        using var stored = JsonDocument.Parse(text);
        Assert.Equal(schema.GetProperty("properties").EnumerateObject().Select(member => member.Name).Order(),
            stored.RootElement.EnumerateObject().Select(member => member.Name).Order());
        foreach (var required in schema.GetProperty("required").EnumerateArray())
        {
            var incomplete = Assert.IsType<JsonObject>(JsonNode.Parse(text));
            incomplete.Remove(Assert.IsType<string>(required.GetString()));
            store.Set(key, incomplete.ToJsonString());
            Assert.Null(RegistryStorage.StoredSession(store, "kb-1"));
        }

        static string PersonKeyOf(JsonElement example) => RegistryStorage.PersonKey(UserId.Parse(Text(example, "did")));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ASignInRecordsItsPersonOnlyWhileItHoldsTheTokenAndNamesNoOneElse(bool registry)
    {
        ISignInKept kept = registry ? RegistryStorage.KeptIn(new MemoryStorage(), "kb-1") : new MemorySignIn();
        var signIn = RegistryTokens();
        Assert.False(await kept.RecordPersonKeyAsync(signIn.Access, "jo"));
        Assert.Null(await kept.HeldAsync());
        await kept.KeepAsync(signIn);
        Assert.False(await kept.RecordPersonKeyAsync("another access", "jo"));
        Assert.Equal(signIn, await kept.HeldAsync());
        Assert.True(await kept.RecordPersonKeyAsync(signIn.Access, "jo"));
        var named = signIn with { PersonKey = "jo" };
        Assert.Equal(named, await kept.HeldAsync());
        Assert.True(await kept.RecordPersonKeyAsync(signIn.Access, "jo"));
        Assert.False(await kept.RecordPersonKeyAsync(signIn.Access, "ann"));
        Assert.Equal(named, await kept.HeldAsync());
        Assert.Equal("renewed", await kept.RenewedAsync(named, "renewed", "renewed refresh"));
        Assert.Equal(named with { Access = "renewed", Refresh = "renewed refresh" }, await kept.HeldAsync());
    }

    [Fact]
    public async Task ASignInBegunIsKeptAsTheStoredTableStatesIt()
    {
        using var table = ReadSpec("session/stored.json");
        var schema = table.RootElement.GetProperty("pendingAuthorization");
        var issuerSchema = schema.GetProperty("properties").GetProperty("issuer");
        using var server = new Handler();
        using var http = new HttpClient(server);
        server.Other = (request, _) => Task.FromResult(request.RequestUri?.AbsolutePath switch
        {
            "/.well-known/oauth-protected-resource" => new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = JsonContent.Create(new ProtectedResourceMetadata
                {
                    Resource = "https://kb.test",
                    AuthorizationServers = ["https://issuer.test"],
                    BearerMethodsSupported = [ProtectedResourceMetadataBearerMethodsSupportedItem.Header],
                }),
            },
            "/.well-known/openid-configuration" => new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = JsonContent.Create(new { issuer = "https://issuer.test", authorization_endpoint = "https://issuer.test/authorize", token_endpoint = "https://issuer.test/token" }),
            },
            _ => throw new InvalidOperationException("Unexpected issuer request."),
        });
        var endpoint = Assert.IsType<KbEndpoint.HttpEndpointCase>(RegistryKb("prior", "prior.test").Endpoint).Value;
        async Task<JsonElement> Kept(BeginAuthorizationOptions options)
        {
            var store = new MemoryStorage();
            await RedirectSignIn.BeginAuthorizationAsync(options, store, http);
            return JsonSerializer.Deserialize<JsonElement>(Assert.IsType<string>(store.Get(RedirectSignIn.PendingAuthorizationKey)));
        }
        static string[] Members(JsonElement value) => value.EnumerateObject().Select(member => member.Name).Order().ToArray();
        static string[] RequiredOf(JsonElement schema) =>
            schema.GetProperty("required").EnumerateArray().Select(name => Assert.IsType<string>(name.GetString())).Order().ToArray();

        var full = await Kept(new BeginAuthorizationOptions(endpoint, "https://app.test/callback", "kb-a", "did:web:kb-a.test", "A"));
        Assert.Equal(Members(schema.GetProperty("properties")), Members(full));
        var issuer = Members(full.GetProperty("issuer")).ToHashSet();
        Assert.Subset(issuer, RequiredOf(issuerSchema).ToHashSet());
        Assert.Subset(Members(issuerSchema.GetProperty("properties")).ToHashSet(), issuer);
        var bare = await Kept(new BeginAuthorizationOptions(endpoint, "https://app.test/callback"));
        Assert.Equal(RequiredOf(schema), Members(bare));
    }

    [Fact]
    public void OnePlaceFollowsItsTable()
    {
        using var table = ReadSpec("session/registry-cases.json");
        var cases = table.RootElement.GetProperty("cases").EnumerateArray().ToArray();
        Assert.NotEmpty(cases);
        foreach (var row in cases)
        {
            var one = Required<KbEndpoint>(row.GetProperty("one"));
            var other = Required<KbEndpoint>(row.GetProperty("other"));
            var same = row.GetProperty("samePlace").GetBoolean();
            Assert.True(SemiontBrowser.SamePlace(one, other) == same, Text(row, "why"));
            Assert.True(SemiontBrowser.SamePlace(other, one) == same, Text(row, "why") + ", the other way round");
        }
    }

    [Fact]
    public void OpenResourcesAreShownInTheOrderOfTheirTable()
    {
        using var table = ReadSpec("session/registry-cases.json");
        var cases = table.RootElement.GetProperty("openResourceOrder").EnumerateArray().ToArray();
        Assert.NotEmpty(cases);
        foreach (var row in cases)
        {
            var open = Assert.IsType<OpenResource[]>(RegistryStorage.Read<OpenResource[]>(row.GetProperty("open").GetRawText()));
            var shown = row.GetProperty("shown").EnumerateArray().Select(id => Assert.IsType<string>(id.GetString())).ToArray();
            var sorted = OpenResources.SortOpenResources(open).Select(tab => tab.Id.Value).ToArray();
            Assert.True(shown.SequenceEqual(sorted), Text(row, "why") + ": shown " + string.Join(", ", sorted));
        }
    }

    public static IEnumerable<object[]> OpenResourceCases()
    {
        using var table = ReadSpec("session/open-resource-cases.json");
        foreach (var row in table.RootElement.GetProperty("cases").EnumerateArray()) yield return [Text(row, "why")];
    }

    /// <summary>
    /// A registry over a knowledge base that answers as the case says, with the case's resources open in it before its
    /// session is active: once it is active, the resources the registry asked for and those still open are the case's.
    /// </summary>
    [Theory]
    [MemberData(nameof(OpenResourceCases))]
    public async Task OpenResourcesAreCheckedOnActivationAsTheirCaseSays(string why)
    {
        using var table = ReadSpec("session/open-resource-cases.json");
        var row = table.RootElement.GetProperty("cases").EnumerateArray().Single(entry => Text(entry, "why") == why).Clone();
        var store = new MemoryStorage();
        var kb = RegistryKb("checked", "checked.test");
        RegistryStorage.SaveKnowledgeBases(store, [kb]);
        store.Set(RegistryStorage.OpenResourcesByKbKey, RegistryStorage.Write(new Dictionary<string, OpenResource[]>
        {
            [kb.Id] = Ids(row.GetProperty("open")).Select((id, order) => new OpenResource(ResourceId.Parse(id), id, 0, order)).ToArray(),
        }));
        var asked = new ConcurrentDictionary<string, bool>(StringComparer.Ordinal);
        var factory = new RegistryFactory((options, _) => Task.FromResult(OpenCaseSession(options.Kb, row, asked)));
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await browser.SetActiveKbAsync(kb.Id, deadline.Token);
        var expectedAsked = Ids(row.GetProperty("asked")).ToHashSet(StringComparer.Ordinal);
        var stillOpen = Ids(row.GetProperty("stillOpen")).ToHashSet(StringComparer.Ordinal);
        bool Checked(BrowserState state) => expectedAsked.SetEquals(asked.Keys) && stillOpen.SetEquals(state.OpenResources.Select(tab => tab.Id.Value));
        try
        {
            await foreach (var state in browser.States(deadline.Token))
                if (Checked(state)) return;
        }
        catch (OperationCanceledException) when (deadline.IsCancellationRequested) { }
        Assert.Fail(why + ": the registry asked for " + string.Join(", ", asked.Keys.Order(StringComparer.Ordinal)) + ", and "
            + string.Join(", ", browser.State.OpenResources.Select(tab => tab.Id.Value).Order(StringComparer.Ordinal)) + " stayed open");

        static string[] Ids(JsonElement ids) => ids.EnumerateArray().Select(id => Assert.IsType<string>(id.GetString())).ToArray();
    }

    /// <summary>
    /// A session with <paramref name="kb"/> that answers as <paramref name="row"/> says: asked to describe itself, as its
    /// entry (`itself`) or not at all (`unanswered`); asked for a resource, with its description (`ready`), as gone
    /// (`gone`, bus.not-found) or not at all (`unanswered`). A request left unanswered fails at its short timeout. Each
    /// resource asked for is noted in <paramref name="asked"/>.
    /// </summary>
    private static OpenedSession OpenCaseSession(KnowledgeBase kb, JsonElement row, ConcurrentDictionary<string, bool> asked)
    {
        var server = new Handler();
        var http = new HttpClient(server);
        var resources = row.GetProperty("resources");
        server.Answer = sent =>
        {
            if (Text(sent, "channel") == BusOperations.BrowseKbRequested.Request.Name)
            {
                switch (Text(row, "kb"))
                {
                    case "itself":
                        Reply(server, sent, BusOperations.BrowseKbRequested.Result.Name,
                            new { response = new { domain = kb.Did["did:web:".Length..], name = kb.Label } });
                        return;
                    case "unanswered": return;
                    case var answer: throw new InvalidOperationException("No knowledge base answers " + answer);
                }
            }
            Assert.Equal(BusOperations.BrowseResourceRequested.Request.Name, Text(sent, "channel"));
            var id = Text(sent.GetProperty("payload"), "resourceId");
            asked[id] = true;
            switch (Text(resources, id))
            {
                case "ready":
                    Reply(server, sent, BusOperations.BrowseResourceRequested.Result.Name,
                        new { response = new { resource = Described(id, id), lastSequence = 1 } });
                    return;
                case "gone":
                    Reply(server, sent, BusOperations.BrowseResourceRequested.Failure.Name, new { message = id + " is gone", code = "not-found" });
                    return;
                case "unanswered": return;
                case var answer: throw new InvalidOperationException("No resource answers " + answer);
            }
        };
        var client = new SemiontClient("https://kb.test", "token", http, timing: new Timing { BusRequestTimeoutMs = 200 });
        return new OpenedSession(client, () =>
        {
            client.Dispose();
            http.Dispose();
            return ValueTask.CompletedTask;
        });
    }

    [Fact]
    public async Task AnOpenResourceIsKeptAsTheStoredTableStatesIt()
    {
        using var table = ReadSpec("session/stored.json");
        var schema = table.RootElement.GetProperty("openResource");
        static string[] Members(JsonElement value) => value.EnumerateObject().Select(member => member.Name).Order().ToArray();
        var required = schema.GetProperty("required").EnumerateArray().Select(name => Assert.IsType<string>(name.GetString())).Order().ToArray();
        var store = new MemoryStorage();
        var kb = RegistryKb("open", "open.test");
        RegistryStorage.SaveKnowledgeBases(store, [kb]);
        var factory = new RegistryFactory((options, _) => Task.FromResult(OpenRegistrySession(options.Kb)));
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await browser.SetActiveKbAsync(kb.Id, deadline.Token);
        browser.AddOpenResource(ResourceId.Parse("full"), "Full", "text/markdown", "file://docs/full.md");
        browser.AddOpenResource(ResourceId.Parse("bare"), "Bare");

        using var kept = JsonDocument.Parse(Assert.IsType<string>(store.Get(RegistryStorage.OpenResourcesByKbKey)));
        var tabs = kept.RootElement.GetProperty(kb.Id).EnumerateArray().ToArray();
        var full = tabs.Single(tab => Text(tab, "id") == "full");
        Assert.Equal(Members(schema.GetProperty("properties")), Members(full));
        Assert.Equal(required, Members(tabs.Single(tab => Text(tab, "id") == "bare")));
        Assert.NotNull(RegistryStorage.Read<OpenResource>(full.GetRawText()));
        foreach (var member in required)
        {
            var incomplete = Assert.IsType<JsonObject>(JsonNode.Parse(full.GetRawText()));
            incomplete.Remove(member);
            Assert.Null(RegistryStorage.Read<OpenResource>(incomplete.ToJsonString()));
        }
    }

    [Fact]
    public async Task RenewalAdoptsNewerCredentialsAndNeverResurrectsSignOut()
    {
        var store = new MemoryStorage();
        var kept = RegistryStorage.KeptIn(store, "one");
        var initial = RegistryTokens();
        await kept.KeepAsync(initial);
        var newer = initial with { Access = "newer", Refresh = "new refresh" };
        await kept.KeepAsync(newer);
        Assert.Equal(newer.Access, await kept.RenewedAsync(initial, "stale", "stale refresh"));
        Assert.Equal(newer, await kept.HeldAsync());
        await kept.ForgetAsync();
        Assert.Null(await kept.RenewedAsync(newer, "renewed after sign-out", "refresh"));
        Assert.Null(await kept.HeldAsync());
    }

    [Fact]
    public async Task NewSelectionWaitsForAndClosesASupersededSession()
    {
        var store = new MemoryStorage();
        var first = RegistryKb("first", "first.test");
        var second = RegistryKb("second", "second.test");
        RegistryStorage.SaveKnowledgeBases(store, [first, second]);
        var began = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var factory = new RegistryFactory(async (options, _) =>
        {
            if (options.Kb.Id == first.Id)
            {
                began.SetResult();
                await release.Task.WaitAsync(deadline.Token);
                return OpenRegistrySession(first, onClose: () => closed.SetResult());
            }
            Assert.True(closed.Task.IsCompletedSuccessfully);
            return OpenRegistrySession(second);
        });
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory));
        await began.Task.WaitAsync(deadline.Token);
        var selecting = browser.SetActiveKbAsync(second.Id, deadline.Token);
        Assert.Equal(second.Id, browser.State.ActiveKbId);
        Assert.Null(browser.State.ActiveSession);
        Assert.False(selecting.IsCompleted);
        release.SetResult();
        await selecting.WaitAsync(deadline.Token);
        Assert.NotNull(browser.State.ActiveSession);
        Assert.True(closed.Task.IsCompletedSuccessfully);
        Assert.Equal(second.Id, store.Get(RegistryStorage.ActiveKey));
    }

    [Fact]
    public async Task ADifferentKnowledgeBaseVoidsOnlyItsSavedTabsAndRaisesConflict()
    {
        var store = new MemoryStorage();
        var one = RegistryKb("one", "one.test");
        var two = RegistryKb("two", "two.test");
        RegistryStorage.SaveKnowledgeBases(store, [one, two]);
        var tab = new OpenResource(ResourceId.Parse("res-1"), "Old tab", 0, 0);
        store.Set(RegistryStorage.OpenResourcesByKbKey, RegistryStorage.Write(new Dictionary<string, OpenResource[]>
        {
            [one.Id] = [tab],
            [two.Id] = [tab],
        }));
        store.Set(RegistryStorage.LastViewedResourceByKbKey, RegistryStorage.Write(new Dictionary<string, ResourceId>
        {
            [one.Id] = tab.Id,
            [two.Id] = tab.Id,
        }));
        var factory = new RegistryFactory((options, _) => Task.FromResult(OpenRegistrySession(options.Kb, observedDomain: "different.test")));
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await browser.SetActiveKbAsync(one.Id, deadline.Token);
        var signals = Assert.IsType<SessionSignals>(browser.State.ActiveSignals);
        await foreach (var notice in signals.KbIdentityConflict.WithCancellation(deadline.Token))
            if (notice is not null) break;
        Assert.Equal(new KbIdentityConflict(one.Did, "did:web:different.test"), signals.KbIdentityConflict.Value);
        Assert.Empty(browser.State.OpenResources);
        Assert.Null(browser.State.LastViewedResource);
        var otherTabs = RegistryStorage.Read<Dictionary<string, OpenResource[]>>(store.Get(RegistryStorage.OpenResourcesByKbKey));
        Assert.Equal(tab, Assert.Single(Assert.IsType<Dictionary<string, OpenResource[]>>(otherTabs)[two.Id]));
        Assert.Equal(one.Did, browser.State.Kbs.Single(kb => kb.Id == one.Id).Did);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NoAnswerAndARefusalToSayAreNoVerdictAndVoidNothing(bool refusing)
    {
        var store = new MemoryStorage();
        var kb = RegistryKb("one", "one.test");
        RegistryStorage.SaveKnowledgeBases(store, [kb]);
        // A stored token with no expiry is renewed before its session starts, and these sessions script no renewal.
        RegistryStorage.StoreSession(store, kb.Id, RegistryTokens() with { Access = TokenTests.Jwt(new { exp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 }) });
        var resource = SourceResource();
        var tab = new OpenResource(resource.Id, "Old tab", 0, 0);
        store.Set(RegistryStorage.OpenResourcesByKbKey, RegistryStorage.Write(new Dictionary<string, OpenResource[]> { [kb.Id] = [tab] }));
        var factory = new ScriptedSessions((_, operation, _) => operation == BusOperations.BrowseResourceRequested.Request.Name
            ? JsonSerializer.SerializeToElement(new { resource, lastSequence = 1 })
            : throw new TransportError(ProtocolFacts.Error(503), "the knowledge base does not answer"));
        factory.SaysWho(Required<UserResponse>(JsonSerializer.Deserialize<JsonElement>(
            """{"did":"did:web:one.test:users:alice","domain":"one.test","email":null,"name":null,"image":null}""")));
        if (refusing)
            factory.RefuseWhen((_, operation, _) => operation == BusOperations.BrowseKbRequested.Request.Name
                ? JsonSerializer.SerializeToElement(new { message = "this knowledge base cannot say what it is" })
                : null);
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await browser.SetActiveKbAsync(kb.Id, deadline.Token);
        // The resources were checked all the same.
        await foreach (var state in browser.States(deadline.Token))
            if (state.OpenResources.Any(open => open.Name == resource.Name)) break;
        var asked = Assert.Single(factory.Transports(kb.Id)).RequestLog
            .Where(logged => logged.Operation == BusOperations.BrowseResourceRequested.Request.Name)
            .Select(logged => logged.Payload.GetProperty("resourceId").GetString());
        Assert.Equal([resource.Id.Value], asked);
        Assert.Equal(tab.Id, Assert.Single(browser.State.OpenResources).Id);
        Assert.Null(Assert.IsType<SessionSignals>(browser.State.ActiveSignals).KbIdentityConflict.Value);
        var entry = browser.State.Kbs.Single();
        Assert.Equal(kb.Label, entry.Label);
        Assert.Null(entry.LastRead);
        Assert.Equal(new KbReadVerdict(KbReadKind.NoVerdict), await browser.ReadActiveKbAsync(deadline.Token));
    }

    [Fact]
    public async Task RegistryCanDisposeFromItsOwnActivation()
    {
        var store = new MemoryStorage();
        var kb = RegistryKb("self", "self.test");
        var close = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var returned = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        SemiontBrowser? owner = null;
        var factory = new RegistryFactory(async (_, _) =>
        {
            await Assert.IsType<SemiontBrowser>(owner).DisposeAsync();
            returned.SetResult();
            return OpenRegistrySession(kb, onClose: () => close.SetResult());
        });
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory));
        owner = browser;
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var activating = browser.AddKbAsync(new NewKnowledgeBase { Did = kb.Did, Endpoint = kb.Endpoint, Label = kb.Label }, RegistryTokens(), deadline.Token);
        await returned.Task.WaitAsync(deadline.Token);
        await activating.WaitAsync(deadline.Token);
        await browser.DisposeAsync().AsTask().WaitAsync(deadline.Token);
        Assert.True(close.Task.IsCompletedSuccessfully);
    }

    [Fact]
    public async Task DisposalReportsTheFirstFailureFromBackgroundActivation()
    {
        var store = new MemoryStorage();
        RegistryStorage.SaveKnowledgeBases(store, [RegistryKb("first", "first.test")]);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var failure = new InvalidOperationException("Activation failed.");
        var browser = new SemiontBrowser(new SemiontBrowserConfig(store, new RegistryFactory((_, _) =>
        {
            started.SetResult();
            return Task.FromException<OpenedSession>(failure);
        })));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await started.Task.WaitAsync(deadline.Token);
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => browser.DisposeAsync().AsTask().WaitAsync(deadline.Token));
        Assert.Same(failure, error);
        Assert.Null(browser.State.ActiveSession);
    }

    [Fact]
    public async Task ExternalStorageWritesRefreshTabsAndEndADeletedSession()
    {
        var store = new ExternallyWritableStorage();
        var kb = RegistryKb("active", "active.test");
        RegistryStorage.SaveKnowledgeBases(store, [kb]);
        RegistryStorage.StoreSession(store, kb.Id, RegistryTokens());
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var factory = new RegistryFactory((options, _) => Task.FromResult(OpenRegistrySession(options.Kb, onClose: () => closed.SetResult())));
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await browser.SetActiveKbAsync(kb.Id, deadline.Token);
        await foreach (var state in browser.States(deadline.Token))
            if (state.Kbs.Single().LastRead is not null) break;
        var tab = new OpenResource(ResourceId.Parse("res-1"), "Opened in another context", 0, 0);
        store.WriteFromElsewhere(RegistryStorage.OpenResourcesByKbKey,
            RegistryStorage.Write(new Dictionary<string, OpenResource[]> { [kb.Id] = [tab] }));
        await foreach (var state in browser.States(deadline.Token))
            if (state.OpenResources.Contains(tab)) break;
        store.WriteFromElsewhere(RegistryStorage.SessionKey(kb.Id), null);
        await closed.Task.WaitAsync(deadline.Token);
        Assert.Null(browser.State.ActiveSession);
        Assert.Equal(KbSessionStatus.SignedOut, browser.KbSessionStatus(kb.Id));
    }

    private sealed class ExternallyWritableStorage : ISessionStorage
    {
        private readonly object gate = new();
        private readonly Dictionary<string, string> values = new(StringComparer.Ordinal);
        private readonly List<Action<string, string?>> listeners = [];
        public string? Get(string key) { lock (gate) return values.GetValueOrDefault(key); }
        public void Set(string key, string value) => Update(key, _ => value);
        public void Delete(string key) => Update(key, _ => null);
        public void Update(string key, Func<string?, string?> change)
        {
            lock (gate)
            {
                if (change(values.GetValueOrDefault(key)) is { } next) values[key] = next;
                else values.Remove(key);
            }
        }
        public IDisposable Subscribe(Action<string, string?> onChange)
        {
            lock (gate) listeners.Add(onChange);
            return new Subscription(() => { lock (gate) listeners.Remove(onChange); });
        }
        internal string[] Keys() { lock (gate) return values.Keys.ToArray(); }
        internal void WriteFromElsewhere(string key, string? value)
        {
            Update(key, _ => value);
            Action<string, string?>[] notify;
            lock (gate) notify = listeners.ToArray();
            foreach (var listener in notify) listener(key, value);
        }
        private sealed class Subscription(Action close) : IDisposable
        {
            public void Dispose() => close();
        }
    }

    [Fact]
    public async Task RedirectUsesPkceAndLandsOnlyOnTheKnowledgeBaseThatAnswered()
    {
        Assert.Equal("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            RedirectSignIn.CodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
        var store = new MemoryStorage();
        var expected = RegistryKb("prior", "prior.test");
        RegistryStorage.SaveKnowledgeBases(store, [expected]);
        RegistryStorage.StoreSession(store, expected.Id, RegistryTokens());
        using var server = new Handler();
        using var http = new HttpClient(server);
        var exchanges = 0;
        server.Other = async (request, cancellation) =>
        {
            switch (request.RequestUri?.AbsolutePath)
            {
                case "/.well-known/oauth-protected-resource":
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = JsonContent.Create(new ProtectedResourceMetadata
                        {
                            Resource = "https://kb.test",
                            AuthorizationServers = ["https://issuer.test"],
                            BearerMethodsSupported = [ProtectedResourceMetadataBearerMethodsSupportedItem.Header],
                        }),
                    };
                case "/.well-known/openid-configuration":
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = JsonContent.Create(new { issuer = "https://issuer.test", authorization_endpoint = "https://issuer.test/authorize", token_endpoint = "https://issuer.test/token" }),
                    };
                case "/token":
                    Interlocked.Increment(ref exchanges);
                    var posted = await (request.Content ?? throw new InvalidOperationException("Missing form")).ReadAsStringAsync(cancellation);
                    Assert.Contains("grant_type=authorization_code", posted);
                    Assert.Contains("code_verifier=", posted);
                    Assert.Contains("client_id=semiont-browser", posted);
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = JsonContent.Create(new { access_token = "verified access", refresh_token = "verified refresh" }),
                    };
                default: throw new InvalidOperationException("Unexpected issuer request.");
            }
        };
        server.Answer = sent => Reply(server, sent, BusOperations.BrowseKbRequested.Result.Name,
            new { response = new { domain = "observed.test", name = "Observed" } });
        var factory = new RegistryFactory((options, _) => Task.FromResult(OpenRegistrySession(options.Kb)));
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var endpoint = Assert.IsType<KbEndpoint.HttpEndpointCase>(expected.Endpoint).Value;
        var options = new BeginAuthorizationOptions(endpoint, "https://app.test/callback", expected.Id);
        var url = await BrowserSignIn.BeginSignInAsync(browser, options, http, deadline.Token);
        Assert.Contains("code_challenge_method=S256", url);
        var pending = Assert.IsType<PendingAuthorization>(RegistryStorage.Read<PendingAuthorization>(store.Get(RedirectSignIn.PendingAuthorizationKey)));
        Assert.Contains("code_challenge=" + RedirectSignIn.CodeChallenge(pending.Verifier), url);
        var callback = options.RedirectUri + "?code=approved&state=" + pending.State;
        var outcome = await BrowserSignIn.CompleteSignInAsync(browser, callback, http, deadline.Token);
        Assert.Equal("did:web:observed.test", outcome.Kb.Did);
        Assert.Equal(expected.Did, outcome.Expected?.Did);
        Assert.Equal(expected.Endpoint, outcome.Kb.Endpoint);
        Assert.NotEqual(expected.Id, outcome.Kb.Id);
        Assert.Equal(RegistryTokens(), RegistryStorage.StoredSession(store, expected.Id));
        Assert.Equal("verified refresh", RegistryStorage.StoredSession(store, outcome.Kb.Id)?.Refresh);
        var replay = await Assert.ThrowsAsync<SignInError>(() => BrowserSignIn.CompleteSignInAsync(browser, callback, http, deadline.Token));
        Assert.Equal("no-pending", replay.Code);
        Assert.Equal(1, exchanges);
    }

    private static KnowledgeBase RegistryKb(string id, string domain) => new()
    {
        Id = id,
        Label = id,
        Did = "did:web:" + domain,
        Endpoint = Required<KbEndpoint>(JsonSerializer.SerializeToElement(new { kind = "http", protocol = "https", host = "kb.test", port = 443 })),
    };

    private static StoredSession RegistryTokens() => new()
    {
        Access = "first access",
        Refresh = "first refresh",
        ClientId = "semiont-browser",
        TokenEndpoint = "https://issuer.test/token",
    };

    private static OpenedSession OpenRegistrySession(KnowledgeBase kb, string? observedDomain = null, Action? onClose = null)
    {
        var server = new Handler();
        var http = new HttpClient(server);
        server.Answer = sent =>
        {
            if (Text(sent, "channel") == BusOperations.BrowseResourceRequested.Request.Name)
            {
                Reply(server, sent, BusOperations.BrowseResourceRequested.Failure.Name, new { message = "Read temporarily unavailable" });
                return;
            }
            Assert.Equal(BusOperations.BrowseKbRequested.Request.Name, Text(sent, "channel"));
            Reply(server, sent, BusOperations.BrowseKbRequested.Result.Name,
                new { response = new { domain = observedDomain ?? kb.Did["did:web:".Length..], name = kb.Label } });
        };
        var client = new SemiontClient("https://kb.test", "token", http);
        return new OpenedSession(client, () =>
        {
            client.Dispose();
            http.Dispose();
            onClose?.Invoke();
            return ValueTask.CompletedTask;
        });
    }

    private sealed class RegistryFactory(Func<SessionFactoryOptions, CancellationToken, Task<OpenedSession>> open) : SessionFactory
    {
        public Task<OpenedSession> OpenAsync(SessionFactoryOptions options, CancellationToken cancellation = default) => open(options, cancellation);
        public Task RevokeAsync(StoredSession stored, CancellationToken cancellation = default) => Task.CompletedTask;
    }
}
