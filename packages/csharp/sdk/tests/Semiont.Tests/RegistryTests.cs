using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Semiont.Authorization;
using Semiont.Discovery;
using Semiont.Errors;
using Semiont.Identifiers;
using Semiont.Registry;
using Semiont.Storage;
using Semiont.State;
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
        var store = new MemoryStorage();
        var session = RegistryTokens() with { RevocationEndpoint = "https://issuer.test/revoke" };
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
        private readonly MemoryStorage memory = new();
        private Action<string, string?>? listener;
        public string? Get(string key) => memory.Get(key);
        public void Set(string key, string value) => memory.Set(key, value);
        public void Delete(string key) => memory.Delete(key);
        public void Update(string key, Func<string?, string?> change) => memory.Update(key, change);
        public IDisposable Subscribe(Action<string, string?> onChange)
        {
            listener = onChange;
            return new Subscription(() => listener = null);
        }
        internal void WriteFromElsewhere(string key, string? value)
        {
            memory.Update(key, _ => value);
            listener?.Invoke(key, value);
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
