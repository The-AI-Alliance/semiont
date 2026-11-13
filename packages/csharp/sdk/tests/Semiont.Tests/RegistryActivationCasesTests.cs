using System.Collections.Concurrent;
using System.Text.Json;
using Semiont.Errors;
using Semiont.Protocol;
using Semiont.Registry;
using Semiont.Session;
using Semiont.Storage;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

// How a registry activates a knowledge base, held to protocol/specs/src/session/registry-activation-cases.json: when its
// factory refuses the session, once its close has begun, and when another knowledge base's session is active; and what it
// says when its factory fails with something that is not one of the session's own errors, held to
// protocol/specs/src/session/registry-factory-failure-cases.json. Every row's registry keeps its knowledge bases in a
// storage where each is registered with a sign-in kept that names alice, and activates the first as it is made. Its factory
// records each knowledge base it is asked for a session of, in order, and then refuses as the row says or builds the
// session SemiontSession.FromKeptAsync makes over that kept sign-in. The first knowledge base's client keeps in a storage
// that records its write of the save the client owes in the same list: `switching` holds the order of the two to the rule,
// and `closing` begins its activations while that write is held open.
public sealed partial class TransportTests
{
    private const string RegistryActivationCases = "session/registry-activation-cases.json";
    private const string RegistryFactoryFailureCases = "session/registry-factory-failure-cases.json";
    private const string WroteTheOwedSave = "wrote the owed save";

    [Fact]
    public void TheActivationTablesHoldOnlyTheSectionsTheirRunnerRuns()
    {
        using var activation = ReadSpec(RegistryActivationCases);
        Assert.Equal(new[] { "closed", "refused", "switching" }, Sections(activation));
        using var failure = ReadSpec(RegistryFactoryFailureCases);
        Assert.Equal(new[] { "cases" }, Sections(failure));
    }

    [Fact]
    public async Task ARegistrySaysItsFactorysRefusalAsTheRefusedCasesSay()
    {
        using var table = ReadSpec(RegistryActivationCases);
        var rows = table.RootElement.GetProperty("refused").EnumerateArray().ToArray();
        Assert.NotEmpty(rows);
        foreach (var row in rows)
        {
            var refusal = row.GetProperty("refusal");
            AssertSaid(row, await SaidOfARefusalAsync(new SessionError(Text(refusal, "own"), Text(refusal, "message")), Text(row, "why")));
        }
    }

    [Fact]
    public async Task ARegistryRefusesAnActivationOnceItsCloseHasBegunAsTheClosedCasesSay()
    {
        using var table = ReadSpec(RegistryActivationCases);
        var rows = table.RootElement.GetProperty("closed").EnumerateArray().ToArray();
        Assert.NotEmpty(rows);
        foreach (var row in rows) await RegistryClosedCaseAsync(row);
    }

    [Fact]
    public async Task ARegistryEndsItsActiveSessionBeforeItAsksForTheNextAsTheSwitchingCasesSay()
    {
        using var table = ReadSpec(RegistryActivationCases);
        var rows = table.RootElement.GetProperty("switching").EnumerateArray().ToArray();
        Assert.NotEmpty(rows);
        foreach (var row in rows) await RegistrySwitchingCaseAsync(row);
    }

    [Fact]
    public async Task ARegistrySaysItsFactorysOtherFailureAsTheFactoryFailureCasesSay()
    {
        using var table = ReadSpec(RegistryFactoryFailureCases);
        var rows = table.RootElement.GetProperty("cases").EnumerateArray().ToArray();
        Assert.NotEmpty(rows);
        foreach (var row in rows)
        {
            var failure = row.GetProperty("failure");
            AssertSaid(row, await SaidOfARefusalAsync(new TransportError(Text(failure, "transport"), Text(failure, "message")), Text(row, "why")));
        }
    }

    /// <summary>The sections of a case table: its members that hold rows.</summary>
    private static string[] Sections(JsonDocument table) => table.RootElement.EnumerateObject()
        .Where(member => member.Value.ValueKind == JsonValueKind.Array).Select(member => member.Name).Order(StringComparer.Ordinal).ToArray();

    /// <summary>
    /// No session being active, a registry activates a registered knowledge base with a kept sign-in, as it is made, over a
    /// factory that refuses with <paramref name="refusal"/>. Gives what the registry said on its errors once the activation
    /// has returned, until they end as it closes. By then no session is active, its factory was asked for one session, and
    /// the storage's active key names that knowledge base.
    /// </summary>
    private static async Task<List<SemiontError>> SaidOfARefusalAsync(SemiontError refusal, string why)
    {
        var steps = new ConcurrentQueue<string>();
        var clock = new TestClock();
        var store = new MemoryStorage();
        var kb = RegistryKb("kb-a", "kb-a.test");
        Register(store, clock, kb);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store,
            Recording(steps, (_, _) => Task.FromException<OpenedSession>(refusal)), clock));
        // The activation begun as the registry was made has returned once the registry is no longer activating; a second
        // activation of the same knowledge base would ask the factory again.
        await foreach (var state in browser.States(deadline.Token))
            if (!state.SessionActivating) break;

        Assert.True(steps.SequenceEqual([AskedFor(kb)]), why + ": the factory was asked [" + string.Join(", ", steps) + "]");
        Assert.True(browser.State.ActiveSession is null, why + ": a session is active");
        Assert.Equal(kb.Id, store.Get(RegistryStorage.ActiveKey));
        await using IAsyncEnumerator<SemiontError> errors = browser.Errors(deadline.Token).GetAsyncEnumerator();
        var told = errors.MoveNextAsync().AsTask();
        await browser.DisposeAsync();
        return await SaidUntilEndAsync(errors, told, deadline.Token);
    }

    /// <summary>
    /// kb-a's session is active, and kb-b is activated once the registry's close has returned, or while its close waits for
    /// kb-a's client to write the save it owes: from within that write, and from the runner while the write is held. Each
    /// activation is refused with bus.closed by the time its call returns; the factory is asked for nothing more, nothing is
    /// said on the registry's errors, and the storage's active key still names kb-a. A second close does nothing.
    /// </summary>
    private static async Task RegistryClosedCaseAsync(JsonElement row)
    {
        var why = Text(row, "why");
        var closing = Text(row, "while") switch
        {
            "closed" => false,
            "closing" => true,
            var other => throw new InvalidOperationException(why + ": no registry activates while " + other),
        };
        var steps = new ConcurrentQueue<string>();
        var refused = new ConcurrentQueue<Exception?>();
        var clock = new TestClock();
        var store = new MemoryStorage();
        var first = RegistryKb("kb-a", "kb-a.test");
        var next = RegistryKb("kb-b", "kb-b.test");
        Register(store, clock, first, next);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var released = new ManualResetEventSlim();
        var writing = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        SemiontBrowser? registry = null;
        var keeping = new WatchedStorage(key =>
        {
            if (key != OwedSave(first)) return;
            steps.Enqueue(WroteTheOwedSave);
            refused.Enqueue(RefusalAtTheCall(() => Assert.IsType<SemiontBrowser>(registry).SetActiveKbAsync(next.Id, deadline.Token)));
            writing.TrySetResult();
            if (!released.Wait(TimeSpan.FromSeconds(10))) throw new InvalidOperationException(why + ": the runner never released the owed save's write");
        });
        var factory = Recording(steps, (options, cancellation) => KeepingSessionAsync(options.Kb,
            RegistryStorage.KeptIn(options.Storage, options.Kb.Id), options.Kb.Id == first.Id ? keeping : new MemoryStorage(), clock, cancellation));
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory, clock));
        registry = browser;
        var opened = await ActiveSessionAsync(browser, deadline.Token);
        await Assert.IsType<SemiontSession>(opened.Session).ReadyAsync(deadline.Token);
        if (closing) await OwingItsSaveAsync(opened, deadline.Token);

        await using IAsyncEnumerator<SemiontError> errors = browser.Errors(deadline.Token).GetAsyncEnumerator();
        var told = errors.MoveNextAsync().AsTask();
        var close = browser.DisposeAsync().AsTask();
        if (closing)
        {
            await writing.Task.WaitAsync(deadline.Token);
            refused.Enqueue(RefusalAtTheCall(() => browser.SetActiveKbAsync(next.Id, deadline.Token)));
            released.Set();
        }
        await close.WaitAsync(deadline.Token);
        if (!closing) refused.Enqueue(RefusalAtTheCall(() => browser.SetActiveKbAsync(next.Id, deadline.Token)));
        var said = await SaidUntilEndAsync(errors, told, deadline.Token);

        Assert.True(refused.Count == (closing ? 2 : 1), why + ": " + refused.Count + " activations were begun");
        foreach (var refusal in refused)
            Assert.Equal(ProtocolFacts.BusError("closed"), Assert.IsType<BusRequestError>(refusal).Code);
        string[] asked = closing ? [AskedFor(first), WroteTheOwedSave] : [AskedFor(first)];
        Assert.True(asked.SequenceEqual(steps), why + ": the factory and the storage were asked [" + string.Join(", ", steps) + "]");
        Assert.True(said.Count == 0, why + ": the registry said [" + string.Join(", ", said.Select(error => error.Code)) + "]");
        Assert.Equal(first.Id, store.Get(RegistryStorage.ActiveKey));

        await browser.DisposeAsync();
        Assert.True(asked.SequenceEqual(steps), why + ": a second close asked [" + string.Join(", ", steps) + "]");
    }

    /// <summary>
    /// kb-a's session is active, its client owing a save to a storage that writes it or refuses every write, and kb-b is
    /// activated over a factory that builds its session or refuses with one of the session's own errors. The factory is
    /// asked for kb-b only once the storage was asked to write kb-a's owed save; what the registry says once the activation
    /// has returned, until its errors end as it closes, is the row's, and a session is active as the row says.
    /// </summary>
    private static async Task RegistrySwitchingCaseAsync(JsonElement row)
    {
        var why = Text(row, "why");
        var refuses = Text(row, "storage") switch
        {
            "writes" => false,
            "refuses" => true,
            var other => throw new InvalidOperationException(why + ": no storage " + other),
        };
        var refusal = RefusalOfTheNext(row.GetProperty("next"), why);
        var steps = new ConcurrentQueue<string>();
        var clock = new TestClock();
        var store = new MemoryStorage();
        var first = RegistryKb("kb-a", "kb-a.test");
        var next = RegistryKb("kb-b", "kb-b.test");
        Register(store, clock, first, next);
        var keeping = new WatchedStorage(key =>
        {
            if (key == OwedSave(first)) steps.Enqueue(WroteTheOwedSave);
            if (refuses) RefuseTheWrite(key);
        });
        var factory = Recording(steps, (options, cancellation) => options.Kb.Id == first.Id || refusal is null
            ? KeepingSessionAsync(options.Kb, RegistryStorage.KeptIn(options.Storage, options.Kb.Id),
                options.Kb.Id == first.Id ? keeping : new MemoryStorage(), clock, cancellation)
            : Task.FromException<OpenedSession>(refusal));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using var browser = new SemiontBrowser(new SemiontBrowserConfig(store, factory, clock));
        var opened = await ActiveSessionAsync(browser, deadline.Token);
        await Assert.IsType<SemiontSession>(opened.Session).ReadyAsync(deadline.Token);
        await OwingItsSaveAsync(opened, deadline.Token);

        await using IAsyncEnumerator<SemiontError> errors = browser.Errors(deadline.Token).GetAsyncEnumerator();
        var told = errors.MoveNextAsync().AsTask();
        await browser.SetActiveKbAsync(next.Id, deadline.Token);

        string[] asked = [AskedFor(first), WroteTheOwedSave, AskedFor(next)];
        Assert.True(asked.SequenceEqual(steps), why + ": the factory and the storage were asked [" + string.Join(", ", steps) + "]");
        var active = row.GetProperty("active").GetBoolean();
        Assert.True((browser.State.ActiveSession is not null) == active, why + ": a session is " + (active ? "not " : "") + "active");
        Assert.Equal(next.Id, store.Get(RegistryStorage.ActiveKey));
        await browser.DisposeAsync();
        var codes = (await SaidUntilEndAsync(errors, told, deadline.Token)).Select(error => error.Code).ToArray();
        Assert.True(RegistryErrors(row).SequenceEqual(codes), why + ": the registry said [" + string.Join(", ", codes) + "]");
    }

    /// <summary>What a switching row's next session is refused with: null when it is built.</summary>
    private static SessionError? RefusalOfTheNext(JsonElement next, string why) => next.ValueKind switch
    {
        JsonValueKind.String when next.GetString() == "built" => null,
        JsonValueKind.Object => new SessionError(Text(next, "own"), Text(next, "message")),
        _ => throw new InvalidOperationException(why + ": no factory answers " + next.GetRawText()),
    };

    /// <summary>Holds that the registry said a row's `registryErrors`, each by its code and its message, in order.</summary>
    private static void AssertSaid(JsonElement row, List<SemiontError> said)
    {
        var expected = row.GetProperty("registryErrors").EnumerateArray().Select(error => (Text(error, "code"), Text(error, "message"))).ToArray();
        var actual = said.Select(error => (error.Code, error.Message)).ToArray();
        Assert.True(expected.SequenceEqual(actual), Text(row, "why") + ": the registry said [" + string.Join(", ", actual) + "]");
    }

    /// <summary>Registers each of <paramref name="kbs"/> in <paramref name="store"/>, each with a sign-in kept that names
    /// alice, and the first as the knowledge base active.</summary>
    private static void Register(MemoryStorage store, TimeProvider clock, params KnowledgeBase[] kbs)
    {
        RegistryStorage.SaveKnowledgeBases(store, kbs);
        foreach (var kb in kbs) RegistryStorage.StoreSession(store, kb.Id, NamingSignIn(kb, clock));
        store.Set(RegistryStorage.ActiveKey, kbs[0].Id);
    }

    private static string AskedFor(KnowledgeBase kb) => "asked for " + kb.Id;

    /// <summary>A factory that records in <paramref name="steps"/> each knowledge base it is asked for a session of, and then
    /// answers as <paramref name="open"/> does.</summary>
    private static RegistryFactory Recording(ConcurrentQueue<string> steps, Func<SessionFactoryOptions, CancellationToken, Task<OpenedSession>> open) =>
        new((options, cancellation) =>
        {
            steps.Enqueue(AskedFor(options.Kb));
            return open(options, cancellation);
        });

    private static async Task<OpenedSession> ActiveSessionAsync(SemiontBrowser browser, CancellationToken cancellation)
    {
        await foreach (var state in browser.States(cancellation))
            if (state.ActiveSession is { } active) return active;
        throw new InvalidOperationException("The registry's states ended before a session was active");
    }

    /// <summary>What an activation was refused with by the time its call returned: what the call threw, or what the task it
    /// returned had failed with by then; null when it was not refused by then.</summary>
    private static Exception? RefusalAtTheCall(Func<Task> activate)
    {
        Task activation;
        try { activation = activate(); }
        catch (Exception thrown) { return thrown; }
        return activation is { IsFaulted: true, Exception.InnerException: { } failed } ? failed : null;
    }
}
