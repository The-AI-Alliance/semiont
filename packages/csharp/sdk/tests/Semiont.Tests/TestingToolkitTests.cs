using System.Text.Json;
using Semiont.Errors;
using Semiont.Protocol;
using Semiont.Registry;
using Semiont.SignIn;
using Semiont.State;
using Semiont.Testing;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

public sealed partial class TransportTests
{
    [Fact]
    public async Task OfflineSessionStartsFromStorageAndTokenChangesStayLiveOnly()
    {
        var stored = RegistryTokens();
        var kept = new MemorySignIn(stored);
        using var session = await TestSessions.CreateTestSessionAsync(new(Kept: kept));
        Assert.Equal(stored.Access, session.Session.Token.Value);
        Assert.Null(session.Session.User.Value);
        Assert.Empty(session.Transport.RequestLog);
        session.SetToken("another token");
        Assert.Equal("another token", session.Session.Token.Value);
        Assert.Equal(stored, await kept.HeldAsync());
        Assert.Null(await session.Session.RefreshAsync("another token"));
        session.SetToken(null);
        Assert.Null(session.Session.Token.Value);
    }

    [Fact]
    public async Task ScriptedSessionsUseRealRenewalStorageAndRecordRevocation()
    {
        var kb = RegistryKb("scripted", "kb.example");
        var storage = new SharedStorage();
        var stored = RegistryTokens();
        RegistryStorage.StoreSession(storage, kb.Id, stored);
        var factory = new ScriptedSessions((id, operation, _) =>
        {
            Assert.Equal(kb.Id, id);
            Assert.Equal(BusOperations.BrowseKbRequested.Request.Name, operation);
            return JsonSerializer.SerializeToElement(new { domain = "kb.example", name = "Test" });
        });
        var user = Required<UserResponse>(JsonSerializer.Deserialize<JsonElement>(
            """{"did":"did:web:kb.example:users:alice","domain":"kb.example","email":null,"name":null,"image":null}"""));
        factory.SaysWho(user);
        factory.QueueRenewals(new Renewal.Token("renewed access"));
        using var signals = new SessionSignals();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using (var opened = await factory.OpenAsync(new(kb, storage, signals, error => throw error), deadline.Token))
        {
            var session = Assert.IsType<Session.SemiontSession>(opened.Session);
            Assert.Equal(user.Did, session.User.Value?.Did);
            Assert.Equal("renewed access", await session.RefreshAsync(stored.Access, deadline.Token));
            Assert.Equal("renewed access", RegistryStorage.StoredSession(storage, kb.Id)?.Access);
            Assert.Equal(1, factory.Renewed);
            var reply = await opened.Client.Transport.RequestAsync(BusOperations.BrowseKbRequested.Request.Name,
                JsonSerializer.SerializeToElement(new { }), cancellation: deadline.Token);
            Assert.Equal("kb.example", reply?.GetProperty("domain").GetString());
            Assert.Single(Assert.Single(factory.Transports(kb.Id)).RequestLog);
        }

        await factory.RevokeAsync(stored, deadline.Token);
        Assert.Equal(stored, Assert.Single(factory.Revoked));
    }

    [Fact]
    public void SharedStorageUpdatesAtomicallyAndNotifiesOtherContexts()
    {
        var first = new SharedStorage();
        var second = first.Context();
        var heard = new List<(string, string?)>();
        using var changes = second.Subscribe((key, value) => heard.Add((key, value)));
        second.Set("key", "first");
        first.Update("key", current => current + " second");
        first.Delete("key");
        Assert.Equal(new (string, string?)[] { ("key", "first second"), ("key", null) }, heard);
        Assert.Null(second.Get("key"));
        changes.Dispose();
        Parallel.For(0, 100, _ => first.Update("count", text => new string('a', (text?.Length ?? 0) + 1)));
        Assert.Equal(100, second.Get("count")?.Length);
        Assert.Equal(2, heard.Count);
    }

    [Fact]
    public async Task WireFaultsReachTheRealClient()
    {
        FaultAction[] schedule = [new FaultAction.DropReply(), new FaultAction.RejectEmit(), new FaultAction.Delay(TimeSpan.FromMilliseconds(1)), new FaultAction.DuplicateReply()];
        using var gateway = new FaultyTransport(schedule, (_, _) => JsonSerializer.SerializeToElement(new { value = 42 }));
        using var session = await TestSessions.CreateTestSessionAsync(new(Transport: gateway));
        session.SetToken("test");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await OpenAsync(session.Client.Transport);
        var operation = BusOperations.BrowseKbRequested.Request.Name;
        var empty = JsonSerializer.SerializeToElement(new { });
        Task<JsonElement?> AskAsync(int? timeoutMs = null) => session.Client.Transport.RequestAsync(operation, empty, timeoutMs, deadline.Token);

        var timeout = await Assert.ThrowsAsync<BusRequestError>(() => AskAsync(200));
        Assert.Equal(ProtocolFacts.BusError("timeout"), timeout.Code);
        var rejected = await Assert.ThrowsAsync<TransportError>(() => AskAsync());
        Assert.Equal(400, rejected.Status);
        Assert.Equal(42, (await AskAsync())?.GetProperty("value").GetInt32());
        Assert.Equal(42, (await AskAsync())?.GetProperty("value").GetInt32());
        Assert.Equal(schedule, gateway.RequestLog.Select(entry => entry.Action));
        Assert.Equal(4, gateway.RequestLog.Select(entry => entry.CorrelationId).Distinct().Count());
    }

    [Fact]
    public async Task LivenessAssertionsDetectSilenceAnUnsettledPathAndDuplicateDelivery()
    {
        var never = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var spec = new LivenessSpec(_ => new([Task.CompletedTask], [Task.CompletedTask]), TimeSpan.FromMilliseconds(5),
            0, Liveness.FaultSchedules(3, new Random(3)));
        await Liveness.AssertLivenessAxiomsAsync(spec);
        var silent = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Liveness.AssertLivenessAxiomsAsync(spec with { Setup = _ => new([never.Task], []) }));
        Assert.StartsWith("L1:", silent.Message);
        var unsettled = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Liveness.AssertLivenessAxiomsAsync(spec with { Setup = _ => new([never.Task], [never.Task]) }));
        Assert.StartsWith("L2:", unsettled.Message);
        var ops = Liveness.DeliveryOps(20, 8, new Random(4));
        Assert.All(ops, steps => Assert.Contains(DeliveryOp.Write, steps));
        await Liveness.AssertExactlyOnceDeliveryAsync(() => new Delivered(duplicate: false), ops);
        var duplicated = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Liveness.AssertExactlyOnceDeliveryAsync(() => new Delivered(duplicate: true), [[DeliveryOp.Write, DeliveryOp.Transition]]));
        Assert.StartsWith("L3:", duplicated.Message);
    }

    private sealed class Delivered(bool duplicate) : DeliverySubject
    {
        private readonly List<string> seen = [];

        public void Write(string eventId) => seen.Add(eventId);
        public void Transition()
        {
            if (duplicate) seen.AddRange(seen.ToArray());
        }
        public Task<IReadOnlyList<string>> DeliveredAsync(CancellationToken cancellation = default) =>
            Task.FromResult<IReadOnlyList<string>>(seen.ToArray());
        public void Dispose() { }
    }
}
