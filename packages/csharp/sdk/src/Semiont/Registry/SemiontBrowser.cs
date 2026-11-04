using System.Threading.Channels;
using Semiont.Authorization;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Session;
using Semiont.Storage;
using Semiont.Types;
using static Semiont.Registry.RegistryStorage;

namespace Semiont.Registry;

public sealed record SignedIn(KbEndpoint Endpoint, KbDescription Description, StoredSession Session,
    string? KbId = null, string? ExpectedDid = null, string? ExpectedName = null);
public sealed record Expected(string Did, string? Name);
public sealed record SignInOutcome(KnowledgeBase Kb, Expected? Expected);
public enum KbReadKind { NoVerdict, Recorded, Conflict }
public sealed record KbReadVerdict(KbReadKind Kind, string? ObservedDid = null, string? ObservedName = null);

public sealed record BrowserState(IReadOnlyList<KnowledgeBase> Kbs, string? ActiveKbId, OpenedSession? ActiveSession,
    SessionSignals? ActiveSignals, bool SessionActivating, IReadOnlyList<OpenResource> OpenResources,
    ResourceId? LastViewedResource, string? IdentityToken);

/// <summary>The application's registered knowledge bases and its active session.</summary>
public sealed class SemiontBrowser : IAsyncDisposable
{
    private static readonly KbReadVerdict Unavailable = new(KbReadKind.NoVerdict);
    private readonly SessionFactory factory;
    private readonly TimeProvider clock;
    private readonly object gate = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly Broadcast<BrowserState> states = new(replayLatest: true);
    private readonly Broadcast<SessionError> errors = new(keepForFirst: true);
    private readonly AsyncLocal<bool> ownedWork = new();
    private readonly HashSet<Task> tasks = [];
    private readonly IDisposable? subscription;
    private readonly Channel<string> storageChanges = Channel.CreateUnbounded<string>();
    private BrowserState state;
    private Activation? requested;
    private Task transition = Task.CompletedTask;
    private LiveSession? live;
    private bool closing;
    private Task? disposal;
    private Exception? taskFailure;

    public SemiontBrowser(SemiontBrowserConfig config)
    {
        Storage = config.Storage;
        factory = config.SessionFactory;
        clock = config.TimeProvider ?? TimeProvider.System;
        IReadOnlyList<KnowledgeBase> kbs = [];
        Storage.Update(KnowledgeBasesKey, stored =>
        {
            kbs = ReadKnowledgeBases(stored);
            return stored is null ? null : Write(kbs);
        });
        string? active = null;
        Storage.Update(ActiveKey, previous =>
        {
            active = kbs.Any(kb => kb.Id == previous) ? previous : kbs.FirstOrDefault()?.Id;
            return active;
        });
        state = new BrowserState(kbs, active, null, null, false, [], null, null);
        states.Publish(state);
        subscription = Storage.Subscribe(OnStored);
        lock (gate)
        {
            if (subscription is not null) _ = RunOwned(WatchStorageAsync, background: true);
            if (active is not null) _ = Select(active, replace: false, background: true, default);
        }
    }

    public ISessionStorage Storage { get; }
    public EventBus Bus { get; } = new();
    public BrowserState State => Volatile.Read(ref state);
    public IAsyncEnumerable<BrowserState> States(CancellationToken cancellation = default) => states.Observe(cancellation);
    public IAsyncEnumerable<SessionError> Errors(CancellationToken cancellation = default) => errors.Observe(cancellation);

    public void SetIdentityToken(string? token)
    {
        lock (gate) { RequireOpen(); Publish(state with { IdentityToken = token }); }
    }

    public KbSessionStatus KbSessionStatus(string kbId)
    {
        var stored = StoredSession(Storage, kbId);
        return stored is null ? Registry.KbSessionStatus.SignedOut :
            Tokens.IsTokenExpired(stored.Access, clock.GetUtcNow().ToUnixTimeMilliseconds() / 1000d)
                ? Registry.KbSessionStatus.Expired : Registry.KbSessionStatus.Authenticated;
    }

    public Task SetActiveKbAsync(string? kbId, CancellationToken cancellation = default) =>
        Select(kbId, replace: false, background: false, cancellation);

    public async Task<KnowledgeBase> AddKbAsync(NewKnowledgeBase kb, StoredSession session, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        var added = MakeKb(kb.Label, kb.Endpoint, kb.Did, kb.LastRead);
        Task activate;
        lock (gate)
        {
            RequireOpen();
            StoreSession(Storage, added.Id, session);
            ChangeKbs(items => [.. items, added]);
            activate = Select(added.Id, replace: false, background: false, cancellation);
        }
        await activate.ConfigureAwait(false);
        return added;
    }

    public Task RemoveKbAsync(string kbId, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        lock (gate)
        {
            RequireOpen();
            ClearStoredSession(Storage, kbId);
            ForgetTabs(kbId);
            ChangeKbs(items => items.Where(kb => kb.Id != kbId).ToArray());
            return state.ActiveKbId == kbId
                ? Select(state.Kbs.FirstOrDefault()?.Id, replace: false, background: false, cancellation) : Task.CompletedTask;
        }
    }

    public void UpdateKb(string kbId, string? label = null, KbRead? lastRead = null)
    {
        lock (gate)
        {
            RequireOpen();
            ChangeKbs(items => items.Select(kb => kb.Id == kbId
                ? kb with { Label = label ?? kb.Label, LastRead = lastRead ?? kb.LastRead } : kb).ToArray());
        }
    }

    public Task SignInAsync(string kbId, StoredSession session, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        lock (gate)
        {
            RequireOpen();
            RequireKb(kbId);
            StoreSession(Storage, kbId, session);
            return Select(kbId, replace: true, background: false, cancellation);
        }
    }

    public async Task<SignInOutcome> SignedInAsync(SignedIn signedIn, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        var did = Identity.KbDid(signedIn.Description.Domain).Value;
        var read = ReadNow(signedIn.Description);
        SignInOutcome? result = null;
        Task activate;
        lock (gate)
        {
            RequireOpen();
            ChangeKbs(items =>
            {
                var atAddress = items.Where(kb => SamePlace(kb.Endpoint, signedIn.Endpoint)).ToArray();
                var believed = signedIn.KbId is { } id ? items.FirstOrDefault(kb => kb.Id == id) :
                    atAddress.Length == 1 ? atAddress[0] : null;
                var expected = signedIn.ExpectedDid is { } expectedDid ? new Expected(expectedDid, signedIn.ExpectedName) :
                    believed is not null ? new Expected(believed.Did, believed.Label) : null;
                var existing = atAddress.FirstOrDefault(kb => kb.Did == did);
                var landed = existing is null ? MakeKb(signedIn.Description.Name, signedIn.Endpoint, did, read) :
                    existing with { Label = signedIn.Description.Name, LastRead = read };
                result = new SignInOutcome(landed, expected);
                return existing is null ? [.. items, landed] : items.Select(kb => kb.Id == landed.Id ? landed : kb).ToArray();
            });
            var outcome = result ?? throw new InvalidOperationException("Storage did not apply the knowledge-base update.");
            StoreSession(Storage, outcome.Kb.Id, signedIn.Session);
            activate = Select(outcome.Kb.Id, replace: true, background: false, cancellation);
        }
        await activate.ConfigureAwait(false);
        return result ?? throw new InvalidOperationException("The sign-in was not stored.");
    }

    public Task SignOutAsync(string kbId, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        lock (gate)
        {
            RequireOpen();
            StoredSession? removed = null;
            Storage.Update(SessionKey(kbId), value => { removed = Read<StoredSession>(value); return null; });
            if (removed is { } stored)
                _ = RunOwned(async () =>
                {
                    try { await factory.RevokeAsync(stored, lifetime.Token).ConfigureAwait(false); }
                    catch (SignInError) { /* Revocation is best effort after local sign-out. */ }
                }, background: true);
            Publish(state);
            return state.ActiveKbId == kbId
                ? Select(kbId, replace: true, background: false, cancellation, openSession: false)
                : Task.CompletedTask;
        }
    }

    public void AddOpenResource(ResourceId resource, string name, string? mediaType = null, string? storageUri = null) =>
        ChangeActiveTabs(tabs =>
        {
            if (tabs.Any(tab => tab.Id == resource))
                return tabs.Select(tab => tab.Id == resource ? tab with
                { Name = name, MediaType = mediaType ?? tab.MediaType, StorageUri = storageUri ?? tab.StorageUri } : tab).ToArray();
            var order = tabs.Count == 0 ? 0 : tabs.Max(tab => tab.Order) + 1;
            return [.. tabs, new OpenResource(resource, name, clock.GetUtcNow().ToUnixTimeMilliseconds(), order, mediaType, storageUri)];
        });

    public void RemoveOpenResource(ResourceId resource) => ChangeActiveTabs(tabs => tabs.Where(tab => tab.Id != resource).ToArray());

    public void UpdateOpenResourceName(ResourceId resource, string name) =>
        ChangeActiveTabs(tabs => tabs.Select(tab => tab.Id == resource ? tab with { Name = name } : tab).ToArray());

    public void ReorderOpenResources(int from, int to) => ChangeActiveTabs(tabs =>
    {
        if (from < 0 || to < 0 || from >= tabs.Count || to >= tabs.Count || from == to) return tabs;
        var ordered = Registry.OpenResources.SortOpenResources(tabs).ToList();
        var moving = ordered[from];
        ordered.RemoveAt(from);
        ordered.Insert(to, moving);
        return ordered.Select((tab, index) => tab with { Order = index }).ToArray();
    });

    public void SetLastViewedResource(ResourceId resource)
    {
        lock (gate)
        {
            RequireOpen();
            if (live is not { } session) return;
            UpdateMap<ResourceId>(LastViewedResourceByKbKey, map => map[session.KbId] = resource);
            Project();
        }
    }

    public async Task<KbReadVerdict> ReadActiveKbAsync(CancellationToken cancellation = default)
    {
        LiveSession? current;
        lock (gate) { RequireOpen(); current = live; }
        if (current is null) return Unavailable;
        return await ReadKbAsync(current, cancellation).ConfigureAwait(false);
    }

    private Task Select(string? id, bool replace, bool background, CancellationToken cancellation, bool openSession = true)
    {
        cancellation.ThrowIfCancellationRequested();
        lock (gate)
        {
            RequireOpen();
            if (id is not null) RequireKb(id);
            if (!replace && state.ActiveKbId == id)
            {
                if (requested is not null) return transition.WaitAsync(cancellation);
                if (live is not null) return Task.CompletedTask;
            }
            if (id is null) Storage.Delete(ActiveKey);
            else Storage.Set(ActiveKey, id);

            // The intent is visible before waiting for a previous factory to return.
            requested?.Cancel();
            var previous = live;
            live = null;
            var selection = new Activation(id, openSession, CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, cancellation));
            requested = selection;
            Publish(state with
            {
                ActiveKbId = id,
                ActiveSession = null,
                ActiveSignals = null,
                SessionActivating = id is not null && openSession,
                OpenResources = [],
                LastViewedResource = null,
            });
            var earlier = transition;
            transition = RunOwned(async () =>
            {
                await earlier.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
                await ActivateAsync(selection, previous, cancellation).ConfigureAwait(false);
            }, background);
            return transition;
        }
    }

    private async Task ActivateAsync(Activation selection, LiveSession? previous, CancellationToken caller)
    {
        var token = selection.Source.Token;
        SessionSignals? signals = null;
        OpenedSession? opened = null;
        try
        {
            // Even a superseded transition owns the session it removed.
            if (previous is not null) await previous.DisposeAsync().ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            if (!selection.OpenSession || selection.KbId is not { } id) return;
            KnowledgeBase? kb;
            lock (gate) kb = state.Kbs.FirstOrDefault(kb => kb.Id == id);
            if (kb is null) return;

            var notices = new SessionSignals();
            signals = notices;
            try
            {
                opened = await factory.OpenAsync(new SessionFactoryOptions(kb, Storage, notices, errors.Publish), token)
                    .ConfigureAwait(false);
            }
            catch (SemiontError error)
            {
                if (!token.IsCancellationRequested)
                    errors.Publish(new SessionError(ProtocolFacts.SessionError("construct-failed"), $"Could not open {kb.Label}.", error));
                return;
            }

            lock (gate)
            {
                if (closing || requested != selection || token.IsCancellationRequested) return;
                var current = new LiveSession(id, opened, notices);
                live = current;
                opened = null;
                signals = null;
                Project();
                _ = RunOwned(() => CheckOpenResourcesAsync(current), background: true);
            }
        }
        catch (OperationCanceledException) when (!caller.IsCancellationRequested && token.IsCancellationRequested) { }
        finally
        {
            try { if (opened is not null) await opened.DisposeAsync().ConfigureAwait(false); }
            finally
            {
                signals?.Dispose();
                lock (gate)
                {
                    if (requested == selection)
                    {
                        requested = null;
                        if (!closing) Publish(state with { SessionActivating = false });
                    }
                    selection.Source.Dispose();
                }
            }
        }
    }

    private async Task CheckOpenResourcesAsync(LiveSession current)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, current.Closed);
        var verdict = await ReadKbAsync(current, stop.Token).ConfigureAwait(false);
        ResourceId[] waiting;
        lock (gate)
        {
            if (live != current || closing) return;
            if (verdict is { Kind: KbReadKind.Conflict, ObservedDid: { } observed })
            {
                var expected = state.Kbs.FirstOrDefault(kb => kb.Id == current.KbId);
                ForgetTabs(current.KbId);
                Project();
                if (expected is not null) current.Signals.NotifyKbIdentityConflict(new KbIdentityConflict(expected.Did, observed));
                return;
            }
            if (verdict.Kind != KbReadKind.Recorded) return;
            waiting = ReadTabs(current.KbId).Select(tab => tab.Id).Distinct().ToArray();
        }

        var checks = new System.Collections.Concurrent.ConcurrentDictionary<ResourceId, TabCheck>();
        await Parallel.ForEachAsync(waiting, new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = stop.Token },
            async (resource, token) =>
            {
                try
                {
                    var descriptor = await current.Opened.Client.Browse.Resource(resource).FreshAsync(token).ConfigureAwait(false);
                    checks[resource] = new TabCheck(TabVerdict.Ready, descriptor.Name, MediaTypes.Primary(descriptor));
                }
                catch (BusRequestError error) when (error.Code == ProtocolFacts.BusError("not-found"))
                { checks[resource] = new TabCheck(TabVerdict.Gone); }
                catch (SemiontError) { checks[resource] = new TabCheck(TabVerdict.Unknown); }
            }).ConfigureAwait(false);
        lock (gate)
        {
            if (live != current || closing || checks.IsEmpty) return;
            ChangeTabs(current.KbId, tabs => Registry.OpenResources.ApplyTabChecks(tabs, checks));
            Project();
        }
    }

    private async Task<KbReadVerdict> ReadKbAsync(LiveSession current, CancellationToken cancellation)
    {
        KnowledgeBase? entry;
        lock (gate) entry = state.Kbs.FirstOrDefault(kb => kb.Id == current.KbId);
        if (entry is null) return Unavailable;
        KbDescription description;
        string did;
        try
        {
            description = await current.Opened.Client.Browse.KbAsync(cancellation).ConfigureAwait(false);
            did = Identity.KbDid(description.Domain).Value;
        }
        catch (Exception error) when (error is SemiontError or FormatException) { return Unavailable; }
        if (did != entry.Did) return new KbReadVerdict(KbReadKind.Conflict, did, description.Name);
        lock (gate)
        {
            if (closing || live != current) return Unavailable;
            ChangeKbs(items => items.Select(kb => kb.Id == entry.Id && kb.Did == did
                ? kb with { Label = description.Name, LastRead = ReadNow(description) } : kb).ToArray());
        }
        return new KbReadVerdict(KbReadKind.Recorded);
    }

    private void ChangeActiveTabs(Func<IReadOnlyList<OpenResource>, IReadOnlyList<OpenResource>> change)
    {
        lock (gate)
        {
            RequireOpen();
            if (live is not { } session) return;
            ChangeTabs(session.KbId, change);
            Project();
        }
    }

    private void ChangeTabs(string id, Func<IReadOnlyList<OpenResource>, IReadOnlyList<OpenResource>> change) =>
        UpdateMap<IReadOnlyList<OpenResource>>(OpenResourcesByKbKey, map => map[id] = change(map.GetValueOrDefault(id) ?? []));

    private void ForgetTabs(string id)
    {
        UpdateMap<IReadOnlyList<OpenResource>>(OpenResourcesByKbKey, map => map.Remove(id));
        UpdateMap<ResourceId>(LastViewedResourceByKbKey, map => map.Remove(id));
    }

    private void UpdateMap<T>(string key, Action<Dictionary<string, T>> change) =>
        Storage.Update(key, json =>
        {
            var map = Read<Dictionary<string, T>>(json) ?? [];
            change(map);
            return Write(map);
        });

    private IReadOnlyList<OpenResource> ReadTabs(string id) =>
        Read<Dictionary<string, OpenResource[]>>(Storage.Get(OpenResourcesByKbKey))?.GetValueOrDefault(id) ?? [];

    private void OnStored(string key, string? value)
    {
        if (key == OpenResourcesByKbKey || key == LastViewedResourceByKbKey || key == KnowledgeBasesKey || KbOfSessionKey(key) is not null)
            storageChanges.Writer.TryWrite(key);
    }

    private async Task WatchStorageAsync()
    {
        await foreach (var key in storageChanges.Reader.ReadAllAsync(lifetime.Token).ConfigureAwait(false))
        {
            try
            {
                lock (gate)
                {
                    if (closing) return;
                    if (key == KnowledgeBasesKey)
                    {
                        var kbs = LoadKnowledgeBases(Storage);
                        Publish(state with { Kbs = kbs });
                        if (state.ActiveKbId is { } active && !kbs.Any(kb => kb.Id == active))
                        {
                            _ = Select(kbs.FirstOrDefault()?.Id, replace: false, background: true, default);
                            continue;
                        }
                    }
                    if (KbOfSessionKey(key) is { } signedOut && state.ActiveKbId == signedOut &&
                        StoredSession(Storage, signedOut) is null && (live is not null || requested is not null))
                    {
                        _ = Select(signedOut, replace: true, background: true, default, openSession: false);
                        continue;
                    }
                    Project();
                }
            }
            catch (Exception error)
            {
                errors.Publish(new SessionError(ProtocolFacts.SessionError("auth-failed"), "Could not read a storage change.", error));
            }
        }
    }

    private void ChangeKbs(Func<IReadOnlyList<KnowledgeBase>, IReadOnlyList<KnowledgeBase>> change)
    {
        IReadOnlyList<KnowledgeBase> next = state.Kbs;
        Storage.Update(KnowledgeBasesKey, json =>
        {
            next = Array.AsReadOnly(change(ReadKnowledgeBases(json)).ToArray());
            return Write(next);
        });
        Publish(state with { Kbs = next });
    }

    private void Project()
    {
        var active = live;
        var viewed = active is null ? null : Read<Dictionary<string, ResourceId>>(Storage.Get(LastViewedResourceByKbKey));
        Publish(state with
        {
            ActiveSession = active?.Opened,
            ActiveSignals = active?.Signals,
            OpenResources = active is null ? [] : Registry.OpenResources.SortOpenResources(ReadTabs(active.KbId)),
            LastViewedResource = active is not null && viewed is not null && viewed.TryGetValue(active.KbId, out var last) ? last : null,
        });
    }

    private void Publish(BrowserState updated)
    {
        Volatile.Write(ref state, updated);
        states.Publish(updated);
    }

    private Task RunOwned(Func<Task> action, bool background)
    {
        var task = Task.Run(async () =>
        {
            ownedWork.Value = true;
            try { await action().ConfigureAwait(false); }
            catch (OperationCanceledException error) when (background &&
                (lifetime.IsCancellationRequested || error.CancellationToken.IsCancellationRequested))
            { }
            catch (Exception error) when (background)
            {
                lock (gate) taskFailure ??= error;
            }
            finally { ownedWork.Value = false; }
        });
        tasks.Add(task);
        _ = RemoveCompletedAsync(task);
        return task;
    }

    private async Task RemoveCompletedAsync(Task task)
    {
        await task.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        lock (gate) tasks.Remove(task);
    }

    public ValueTask DisposeAsync()
    {
        lock (gate)
        {
            if (disposal is null)
            {
                closing = true;
                var current = live;
                live = null;
                Publish(state with { ActiveSession = null, ActiveSignals = null, SessionActivating = false, OpenResources = [], LastViewedResource = null });
                var work = tasks.ToArray();
                disposal = Task.Run(() => DrainAsync(current, work));
            }
            return ownedWork.Value ? ValueTask.CompletedTask : new ValueTask(disposal);
        }
    }

    private async Task DrainAsync(LiveSession? active, Task[] work)
    {
        ownedWork.Value = true;
        try
        {
            storageChanges.Writer.TryComplete();
            await ClosePartAsync(() => new ValueTask(lifetime.CancelAsync())).ConfigureAwait(false);
            await ClosePartAsync(() => { subscription?.Dispose(); return ValueTask.CompletedTask; }).ConfigureAwait(false);
            if (active is not null) await ClosePartAsync(active.DisposeAsync).ConfigureAwait(false);
            await Task.WhenAll(work).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
        }
        finally
        {
            states.Close();
            errors.Close();
            Bus.Dispose();
            lifetime.Dispose();
            ownedWork.Value = false;
        }
        if (taskFailure is { } failure) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }

    private async Task ClosePartAsync(Func<ValueTask> close)
    {
        try { await close().ConfigureAwait(false); }
        catch (Exception error) { lock (gate) taskFailure ??= error; }
    }

    private void RequireOpen() => ObjectDisposedException.ThrowIf(closing, this);
    private void RequireKb(string id)
    {
        if (!state.Kbs.Any(kb => kb.Id == id)) throw new ArgumentException("No knowledge base is registered under " + id, nameof(id));
    }

    private KbRead ReadNow(KbDescription description) =>
        new() { At = clock.GetUtcNow().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture), GitBranch = description.GitBranch };

    private static KnowledgeBase MakeKb(string label, KbEndpoint endpoint, string did, KbRead? read) =>
        new() { Id = Guid.NewGuid().ToString(), Label = label, Endpoint = endpoint, Did = did, LastRead = read };

    private static bool SamePlace(KbEndpoint first, KbEndpoint second) => (first, second) switch
    {
        (KbEndpoint.HttpEndpointCase(var a), KbEndpoint.HttpEndpointCase(var b)) =>
            a.Port == b.Port && StringComparer.OrdinalIgnoreCase.Equals(a.Host, b.Host),
        (KbEndpoint.LocalEndpointCase(var a), KbEndpoint.LocalEndpointCase(var b)) => a.KbId == b.KbId,
        _ => false,
    };

    private sealed record Activation(string? KbId, bool OpenSession, CancellationTokenSource Source)
    {
        internal void Cancel() => _ = Source.CancelAsync();
    }

    private sealed class LiveSession : IAsyncDisposable
    {
        private readonly CancellationTokenSource closing = new();
        internal string KbId { get; }
        internal OpenedSession Opened { get; }
        internal SessionSignals Signals { get; }
        internal CancellationToken Closed { get; }

        internal LiveSession(string kbId, OpenedSession opened, SessionSignals signals)
        {
            KbId = kbId;
            Opened = opened;
            Signals = signals;
            Closed = closing.Token;
        }

        public async ValueTask DisposeAsync()
        {
            try { await closing.CancelAsync().ConfigureAwait(false); }
            finally
            {
                try { await Opened.DisposeAsync().ConfigureAwait(false); }
                finally { Signals.Dispose(); closing.Dispose(); }
            }
        }
    }
}

public static class BrowserSignIn
{
    public static Task<string> BeginSignInAsync(SemiontBrowser browser, BeginAuthorizationOptions options,
        HttpClient? httpClient = null, CancellationToken cancellation = default) =>
        RedirectSignIn.BeginAuthorizationAsync(options, browser.Storage, httpClient, cancellation);

    public static async Task<SignInOutcome> CompleteSignInAsync(SemiontBrowser browser, string callbackUrl,
        HttpClient? httpClient = null, CancellationToken cancellation = default)
    {
        var (pending, session) = await RedirectSignIn.CompleteAuthorizationAsync(callbackUrl, browser.Storage, httpClient, cancellation)
            .ConfigureAwait(false);
        var identity = await RedirectSignIn.DescribeConnectionAsync(pending.Target, session.Access, httpClient, cancellation)
            .ConfigureAwait(false);
        return await browser.SignedInAsync(new SignedIn(new KbEndpoint.HttpEndpointCase(pending.Target), identity.Description, session,
            pending.KbId, pending.ExpectedDid, pending.ExpectedName), cancellation).ConfigureAwait(false);
    }
}
