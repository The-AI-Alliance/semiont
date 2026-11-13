using System.Threading.Channels;
using Semiont.Authorization;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.Session;
using Semiont.Storage;
using Semiont.State;
using Semiont.Types;
using static Semiont.Registry.RegistryStorage;
using static Semiont.Resources.ResourceReaders;

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

/// <summary>The application's registered knowledge bases and its active session. Activating a knowledge base ends the
/// session active before, its errors read to their end, before the factory is asked for the next. From the moment its
/// disposal begins, every change to it, an activation among them, is refused at the call with
/// <see cref="BusRequestError"/> bus.closed.</summary>
public sealed class SemiontBrowser : IAsyncDisposable
{
    private static readonly KbReadVerdict Unavailable = new(KbReadKind.NoVerdict);
    private static readonly int ChecksAtOnce = ProtocolFacts.Timing("checksAtOnceCount").GetInt32();
    private readonly SessionFactory factory;
    private readonly TimeProvider clock;
    private readonly Random random;
    private readonly object gate = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly Broadcast<BrowserState> states = new(replayLatest: true);
    private readonly Broadcast<SessionError> errors = new(keptForFirst: SemiontError.KeptForFirstReader);
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
        random = config.Random ?? Random.Shared;
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
    internal TimeProvider Clock => clock;
    internal Random Random => random;
    public EventBus Bus { get; } = new();
    public BrowserState State => Volatile.Read(ref state);
    public IAsyncEnumerable<BrowserState> States(CancellationToken cancellation = default) => states.Observe(cancellation);
    /// <summary>Each refusal of the session factory, and each error a session says of its own, until the registry is
    /// disposed. A refusal that is one of the session's own errors is said as it is; any other is said as
    /// session.construct-failed, with its message. Of what is said before anyone reads it, the latest
    /// errorsKeptForFirstReaderCount (protocol/specs/src/client/timing.json) are kept for the first reader, in the order
    /// said.</summary>
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

    public Task SetActiveKbAsync(string? kbId, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        return Select(kbId, replace: false, background: false, cancellation);
    }

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
        await activate.ConfigureAwait(Spawning.Captures);
        return added;
    }

    public Task RemoveKbAsync(string kbId, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        lock (gate)
        {
            RequireOpen();
            var forgotten = SwapStoredSession(Storage, kbId, null);
            ForgetTabs(kbId);
            ChangeKbs(items => items.Where(kb => kb.Id != kbId).ToArray());
            return ForgetAfterClosing(kbId, forgotten,
                forget => Select(state.Kbs.FirstOrDefault()?.Id, replace: false, background: false, cancellation, forget: forget));
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
            return SignInReplacing(kbId, session, cancellation);
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
            activate = SignInReplacing(outcome.Kb.Id, signedIn.Session, cancellation);
        }
        await activate.ConfigureAwait(Spawning.Captures);
        return result ?? throw new InvalidOperationException("The sign-in was not stored.");
    }

    public Task SignOutAsync(string kbId, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        lock (gate)
        {
            RequireOpen();
            var removed = SwapStoredSession(Storage, kbId, null);
            if (removed is { } stored)
                _ = RunOwned(async () =>
                {
                    try { await factory.RevokeAsync(stored, lifetime.Token).ConfigureAwait(Spawning.Captures); }
                    catch (SignInError) { /* Revocation is best effort after local sign-out. */ }
                }, background: true);
            Publish(state);
            return ForgetAfterClosing(kbId, removed,
                forget => Select(kbId, replace: true, background: false, cancellation, openSession: false, forget: forget));
        }
    }

    // A new sign-in replaces the stored one at once, and forgets the person that one named once the knowledge base's
    // client has closed, before the new sign-in's session opens.
    private Task SignInReplacing(string kbId, StoredSession session, CancellationToken cancellation)
    {
        var replaced = SwapStoredSession(Storage, kbId, session);
        return Select(kbId, replace: true, background: false, cancellation, forget: () => ForgetKept(Storage, kbId, replaced));
    }

    // Forgetting a saved sign-in deletes what is kept for its person only once the knowledge base's client has closed, so
    // nothing its close writes is left: an active knowledge base's in the selection that closes it, any other's at once.
    private Task ForgetAfterClosing(string kbId, StoredSession? forgotten, Func<Action, Task> closing)
    {
        void Forget() => ForgetKept(Storage, kbId, forgotten);
        if (state.ActiveKbId == kbId) return closing(Forget);
        Forget();
        return Task.CompletedTask;
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
        return await ReadKbAsync(current, cancellation).ConfigureAwait(Spawning.Captures);
    }

    /// <summary>
    /// <paramref name="forget"/> runs once the session the selection removes has closed, superseded or not. Callers check
    /// <paramref name="cancellation"/> before they change anything, so a sign-in swapped out is always forgotten.
    /// </summary>
    private Task Select(string? id, bool replace, bool background, CancellationToken cancellation, bool openSession = true, Action? forget = null)
    {
        lock (gate)
        {
            RequireOpen();
            if (id is not null) RequireKb(id);
            if (!replace && state.ActiveKbId == id)
            {
                if (requested is not null) return Spawning.WaitAsync(transition, cancellation);
                if (live is not null) return Task.CompletedTask;
            }
            if (id is null) Storage.Delete(ActiveKey);
            else Storage.Set(ActiveKey, id);

            // The intent is visible before waiting for a previous factory to return.
            requested?.Cancel();
            var previous = live;
            live = null;
            var selection = new Activation(id, openSession, CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, cancellation), forget);
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
                await earlier.ConfigureAwait(Spawning.Options(ConfigureAwaitOptions.SuppressThrowing));
                await ActivateAsync(selection, previous, cancellation).ConfigureAwait(Spawning.Captures);
            }, background);
            return transition;
        }
    }

    private async Task ActivateAsync(Activation selection, LiveSession? previous, CancellationToken caller)
    {
        var token = selection.Source.Token;
        SessionSignals? signals = null;
        LiveSession? held = null;
        try
        {
            // Even a superseded transition owns the session it removed, and what is forgotten once that has closed.
            try { if (previous is not null) await previous.DisposeAsync().ConfigureAwait(Spawning.Captures); }
            finally { selection.Forget?.Invoke(); }
            token.ThrowIfCancellationRequested();
            if (!selection.OpenSession || selection.KbId is not { } id) return;
            KnowledgeBase? kb;
            lock (gate) kb = state.Kbs.FirstOrDefault(kb => kb.Id == id);
            if (kb is null) return;

            var notices = new SessionSignals();
            signals = notices;
            OpenedSession opened;
            try
            {
                opened = await factory.OpenAsync(new SessionFactoryOptions(kb, Storage, notices), token).ConfigureAwait(Spawning.Captures);
            }
            catch (SemiontError error)
            {
                if (!token.IsCancellationRequested)
                    errors.Publish(error is SessionError own ? own : new SessionError(ProtocolFacts.SessionError("construct-failed"), error.Message, error));
                return;
            }
            // Read as soon as the factory hands the session back, so this is the first reader of its errors and hears
            // what the session said before anyone read them.
            held = new LiveSession(id, opened, notices, opened.Session is { } session ? ReadAsync(session, notices) : null);
            signals = null;

            lock (gate)
            {
                if (closing || requested != selection || token.IsCancellationRequested) return;
                var current = held;
                live = current;
                held = null;
                Project();
                _ = RunOwned(() => CheckOpenResourcesAsync(current), background: true);
            }
        }
        catch (OperationCanceledException) when (!caller.IsCancellationRequested && token.IsCancellationRequested) { }
        finally
        {
            try { if (held is not null) await held.DisposeAsync().ConfigureAwait(Spawning.Captures); }
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

    /// <summary>
    /// Reads <paramref name="session"/>'s errors, as their one reader, from the first thing it said until they end, when
    /// the session ends. Each of its own it says on the registry's <see cref="Errors"/>. A refusal for lack of permission
    /// has no remedy, and is said through <paramref name="signals"/>, its message the detail. A refusal for want of a valid
    /// token is renewed by the transport that met it, which knows the token it sent, so the registry does nothing with it,
    /// nor with any other failure of the transport.
    /// </summary>
    private async Task ReadAsync(SemiontSession session, SessionSignals signals)
    {
        await foreach (var error in session.Errors().ConfigureAwait(Spawning.Captures))
        {
            if (error is SessionError own) errors.Publish(own);
            else if (error.Code == ProtocolFacts.Error(403)) signals.NotifyPermissionDenied(error.Message);
        }
    }

    private async Task CheckOpenResourcesAsync(LiveSession current)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token, current.Closed);
        var verdict = await ReadKbAsync(current, stop.Token).ConfigureAwait(Spawning.Captures);
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
            waiting = ReadTabs(current.KbId).Select(tab => tab.Id).Distinct().ToArray();
        }

        var checks = new System.Collections.Concurrent.ConcurrentDictionary<ResourceId, TabCheck>();
        await Spawning.ForEachAsync(waiting, new ParallelOptions { MaxDegreeOfParallelism = ChecksAtOnce, CancellationToken = stop.Token },
            async (resource, token) =>
            {
                try
                {
                    var descriptor = await current.Opened.Client.Browse.Resource(resource).FreshAsync(token).ConfigureAwait(Spawning.Captures);
                    checks[resource] = new TabCheck(TabVerdict.Ready, descriptor.Name, PrimaryMediaType(descriptor));
                }
                catch (BusRequestError error) when (error.Code == ProtocolFacts.BusError("not-found"))
                { checks[resource] = new TabCheck(TabVerdict.Gone); }
                catch (SemiontError) { checks[resource] = new TabCheck(TabVerdict.Unknown); }
            }).ConfigureAwait(Spawning.Captures);
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
            description = await current.Opened.Client.Browse.KbAsync(cancellation).ConfigureAwait(Spawning.Captures);
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
        await foreach (var key in Spawning.ReadAll(storageChanges.Reader, lifetime.Token).ConfigureAwait(Spawning.Captures))
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
        var task = Spawning.Run(async () =>
        {
            ownedWork.Value = true;
            try { await action().ConfigureAwait(Spawning.Captures); }
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
        await task.ConfigureAwait(Spawning.Options(ConfigureAwaitOptions.SuppressThrowing));
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
                disposal = Spawning.Run(() => DrainAsync(current, work));
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
            await ClosePartAsync(() => new ValueTask(Spawning.CancelAsync(lifetime))).ConfigureAwait(Spawning.Captures);
            await ClosePartAsync(() => { subscription?.Dispose(); return ValueTask.CompletedTask; }).ConfigureAwait(Spawning.Captures);
            if (active is not null) await ClosePartAsync(active.DisposeAsync).ConfigureAwait(Spawning.Captures);
            await Spawning.WhenAll(work).ConfigureAwait(Spawning.Options(ConfigureAwaitOptions.SuppressThrowing));
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
        try { await close().ConfigureAwait(Spawning.Captures); }
        catch (Exception error) { lock (gate) taskFailure ??= error; }
    }

    private void RequireOpen()
    {
        if (closing) throw new BusRequestError(ProtocolFacts.BusError("closed"), "The knowledge-base registry is closed.");
    }
    private void RequireKb(string id)
    {
        if (!state.Kbs.Any(kb => kb.Id == id)) throw new ArgumentException("No knowledge base is registered under " + id, nameof(id));
    }

    private KbRead ReadNow(KbDescription description) =>
        new() { At = clock.GetUtcNow().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture), GitBranch = description.GitBranch };

    private static KnowledgeBase MakeKb(string label, KbEndpoint endpoint, string did, KbRead? read) =>
        new() { Id = Guid.NewGuid().ToString(), Label = label, Endpoint = endpoint, Did = did, LastRead = read };

    internal static bool SamePlace(KbEndpoint first, KbEndpoint second) => (first, second) switch
    {
        (KbEndpoint.HttpEndpointCase(var a), KbEndpoint.HttpEndpointCase(var b)) =>
            a.Protocol == b.Protocol && a.Port == b.Port && StringComparer.OrdinalIgnoreCase.Equals(a.Host, b.Host),
        (KbEndpoint.LocalEndpointCase(var a), KbEndpoint.LocalEndpointCase(var b)) => a.KbId == b.KbId,
        _ => false,
    };

    private sealed record Activation(string? KbId, bool OpenSession, CancellationTokenSource Source, Action? Forget)
    {
        internal void Cancel() => _ = Spawning.CancelAsync(Source);
    }

    /// <summary>A session the registry holds, with its signals and the reader of its errors, which one the factory handed
    /// back as a client alone has none of.</summary>
    private sealed class LiveSession : IAsyncDisposable
    {
        private readonly CancellationTokenSource closing = new();
        private readonly Task? reading;
        internal string KbId { get; }
        internal OpenedSession Opened { get; }
        internal SessionSignals Signals { get; }
        internal CancellationToken Closed { get; }

        internal LiveSession(string kbId, OpenedSession opened, SessionSignals signals, Task? reading)
        {
            KbId = kbId;
            Opened = opened;
            Signals = signals;
            this.reading = reading;
            Closed = closing.Token;
        }

        // Ending the opened session ends its client, waits for its closing save, and then ends the session and its errors,
        // so the reader has heard what that save said, and is done, before the signals it speaks through close.
        public async ValueTask DisposeAsync()
        {
            try { await Spawning.CancelAsync(closing).ConfigureAwait(Spawning.Captures); }
            finally
            {
                try
                {
                    try { await Opened.DisposeAsync().ConfigureAwait(Spawning.Captures); }
                    finally { if (reading is not null) await reading.ConfigureAwait(Spawning.Captures); }
                }
                finally { Signals.Dispose(); closing.Dispose(); }
            }
        }
    }
}

public static class BrowserSignIn
{
    public static Task<string> BeginSignInAsync(SemiontBrowser browser, BeginAuthorizationOptions options,
        HttpClient? httpClient = null, CancellationToken cancellation = default) =>
        RedirectSignIn.BeginAuthorizationAsync(options, browser.Storage, httpClient, browser.Clock, browser.Random, cancellation);

    public static async Task<SignInOutcome> CompleteSignInAsync(SemiontBrowser browser, string callbackUrl,
        HttpClient? httpClient = null, CancellationToken cancellation = default)
    {
        var (pending, session) = await RedirectSignIn.CompleteAuthorizationAsync(callbackUrl, browser.Storage, httpClient,
            browser.Clock, browser.Random, cancellation).ConfigureAwait(Spawning.Captures);
        var identity = await RedirectSignIn.DescribeConnectionAsync(pending.Target, session.Access, httpClient,
            browser.Clock, browser.Random, cancellation).ConfigureAwait(Spawning.Captures);
        return await browser.SignedInAsync(new SignedIn(new KbEndpoint.HttpEndpointCase(pending.Target), identity.Description, session,
            pending.KbId, pending.ExpectedDid, pending.ExpectedName), cancellation).ConfigureAwait(Spawning.Captures);
    }
}
