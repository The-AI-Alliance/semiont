using System.Threading.Channels;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Protocol;
using Semiont.SignIn;
using Semiont.Types;

namespace Semiont.Session;

public sealed record SessionState(string? Token, UserResponse? User);

public sealed class KeptSession : IDisposable
{
    private readonly ISignInKept kept;
    private readonly TimeProvider clock;
    private readonly Random random;
    private readonly Func<string?, CancellationToken, Task<string?>> renew;
    private readonly Func<string, CancellationToken, Task<UserResponse>> validate;
    private readonly Issuer? issuer;
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim operations = new(1, 1);
    private readonly object gate = new();
    private readonly Broadcast<SessionState> states = new(replayLatest: true);
    private readonly Broadcast<SessionError> errors = new(keepForFirst: true);
    private readonly Channel<bool> changed = Channel.CreateUnbounded<bool>();
    private readonly Task ready;
    private Task<string?>? renewal;
    private SessionState state = new(null, null);
    private volatile bool unanswered;
    private volatile bool ended;
    private int disposed;

    public KeptSession(HttpEndpoint endpoint, ISignInKept kept, HttpClient? httpClient = null,
        TimeProvider? timeProvider = null, Random? random = null)
    {
        string origin;
        try { origin = Gateway.Origin(endpoint); }
        catch (Exception error) when (error is SignInError or System.Text.Json.JsonException)
        { throw new SessionError(ProtocolFacts.SessionError("construct-failed"), "The knowledge-base endpoint is invalid", error); }
        this.kept = kept;
        clock = timeProvider ?? TimeProvider.System;
        this.random = random ?? Random.Shared;
        issuer = new Issuer(httpClient, clock, this.random);
        renew = (holding, cancellation) => issuer.RenewAsync(kept, holding, cancellation);
        validate = (token, cancellation) => Gateway.GetCurrentUserAsync(origin, token, httpClient, clock, cancellation);
        states.Publish(state);
        ready = Task.Run(StartAsync);
    }

    internal KeptSession(ISignInKept kept, Func<string?, CancellationToken, Task<string?>> renew,
        Func<string, CancellationToken, Task<UserResponse>> validate, TimeProvider clock, Random random)
    {
        this.kept = kept;
        this.renew = renew;
        this.validate = validate;
        this.clock = clock;
        this.random = random;
        states.Publish(state);
        ready = Task.Run(StartAsync);
    }

    public SessionState State => Volatile.Read(ref state);
    public string? EndReason { get; private set; }
    public IAsyncEnumerable<SessionState> States(CancellationToken cancellation = default) => states.Observe(cancellation);
    public IAsyncEnumerable<SessionError> Errors(CancellationToken cancellation = default) => errors.Observe(cancellation);
    public Task ReadyAsync(CancellationToken cancellation = default) => ready.WaitAsync(cancellation);

    public async Task<string?> RefreshAsync(string? refused, CancellationToken cancellation = default)
    {
        Task<string?> shared;
        lock (gate)
        {
            lifetime.Token.ThrowIfCancellationRequested();
            if (renewal is null || renewal.IsCompleted) renewal = Task.Run(() => RefusedAsync(refused));
            shared = renewal;
        }
        return await shared.WaitAsync(cancellation).ConfigureAwait(false);
    }

    private void Set(string? token, UserResponse? user)
    {
        lock (gate)
        {
            if (disposed != 0) return;
            var next = new SessionState(token, user);
            Volatile.Write(ref state, next);
            states.Publish(next);
            changed.Writer.TryWrite(true);
        }
    }

    private void Report(string name, Exception? cause = null) => errors.Publish(new SessionError(ProtocolFacts.SessionError(name), cause?.Message ?? name, cause));

    private async Task EndAsync(string reason, string code)
    {
        unanswered = false;
        ended = true;
        Set(null, null);
        await ForgetStoredAsync().ConfigureAwait(false);
        EndReason = reason;
        Report(code);
    }

    private async Task ForgetStoredAsync()
    {
        try { await kept.ForgetAsync(lifetime.Token).ConfigureAwait(false); }
        catch (Exception error) when (error is not OperationCanceledException) { Report("auth-failed", error); }
    }

    private async Task<string?> RenewCoreAsync(bool starting = false)
    {
        if (ended) return null;
        try
        {
            var token = await renew(State.Token, lifetime.Token).ConfigureAwait(false);
            lifetime.Token.ThrowIfCancellationRequested();
            unanswered = false;
            if (token is null && await kept.HeldAsync(lifetime.Token).ConfigureAwait(false) is null)
            {
                ended = true;
                Set(null, null);
                return null;
            }
            Set(token, State.User);
            return token;
        }
        catch (SignInError error)
        {
            lifetime.Token.ThrowIfCancellationRequested();
            if (ProtocolFacts.RetryRefresh(error.Status))
            {
                unanswered = true;
                Set(null, State.User);
                Report(starting ? "auth-failed" : "refresh-exhausted", error);
            }
            else if (starting)
            {
                ended = true;
                Set(null, null);
                await ForgetStoredAsync().ConfigureAwait(false);
            }
            else await EndAsync("expired", "refresh-exhausted").ConfigureAwait(false);
            return null;
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            lifetime.Token.ThrowIfCancellationRequested();
            // A host storage write can fail after the issuer answers. Never publish an unkept grant.
            unanswered = true;
            Set(null, State.User);
            Report(starting ? "auth-failed" : "refresh-exhausted", error);
            return null;
        }
    }

    private async Task StartAsync()
    {
        await operations.WaitAsync(lifetime.Token).ConfigureAwait(false);
        try
        {
            var found = await kept.HeldAsync(lifetime.Token).ConfigureAwait(false);
            if (found is null) { ended = true; return; }
            var issued = Tokens.IsTokenExpired(found.Access, clock.GetUtcNow().ToUnixTimeMilliseconds() / 1000d);
            var token = issued ? await RenewCoreAsync(starting: true).ConfigureAwait(false) : found.Access;
            if (token is null) return;
            Set(token, null);
            for (var ask = 0; ask < 2; ask++)
            {
                try
                {
                    var user = await validate(token, lifetime.Token).ConfigureAwait(false);
                    Set(token, user);
                    return;
                }
                catch (TransportError error) when (error.Code == ProtocolFacts.Error(401))
                {
                    if (issued) { await EndAsync("refused", "credential-refused").ConfigureAwait(false); return; }
                    token = await RenewCoreAsync().ConfigureAwait(false);
                    if (token is null) return;
                    issued = true;
                }
                catch (SemiontError error) { Report("auth-failed", error); return; }
            }
        }
        finally
        {
            operations.Release();
            if (!lifetime.IsCancellationRequested) _ = ScheduleAsync();
        }
    }

    private async Task<string?> RefusedAsync(string? refused)
    {
        await ready.ConfigureAwait(false);
        await operations.WaitAsync(lifetime.Token).ConfigureAwait(false);
        try
        {
            if (ended) return null;
            if (State.Token != refused) return State.Token;
            var token = await RenewCoreAsync().ConfigureAwait(false);
            if (token is null) return null;
            try { Set(token, await validate(token, lifetime.Token).ConfigureAwait(false)); }
            catch (TransportError error) when (error.Code == ProtocolFacts.Error(401))
            { await EndAsync("refused", "credential-refused").ConfigureAwait(false); }
            catch (SemiontError)
            {
                // An unanswered identity request refuses nothing; keep the renewed token and last confirmed user.
            }
            return State.Token;
        }
        finally { operations.Release(); }
    }

    private async Task ScheduleAsync()
    {
        var step = ProtocolFacts.Timing("reconnectMs").GetDouble();
        try
        {
            while (!ended)
            {
                while (changed.Reader.TryRead(out _)) { }
                var retrying = unanswered;
                var token = State.Token;
                var seconds = token is not null ? Tokens.RefreshDelay(token, clock.GetUtcNow().ToUnixTimeMilliseconds() / 1000d) : null;
                if (!retrying && seconds is null)
                {
                    await changed.Reader.ReadAsync(lifetime.Token).ConfigureAwait(false);
                    continue;
                }
                var delay = retrying ? TimeSpan.FromMilliseconds(step / 2 + random.NextDouble() * step / 2) : TimeSpan.FromSeconds(seconds ?? throw new InvalidOperationException("No renewal delay"));
                using var waiting = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                var timer = Task.Delay(delay, clock, waiting.Token);
                var change = changed.Reader.WaitToReadAsync(waiting.Token).AsTask();
                var completed = await Task.WhenAny(timer, change).ConfigureAwait(false);
                await waiting.CancelAsync().ConfigureAwait(false);
                if (completed != timer) continue;
                await timer.ConfigureAwait(false);
                await operations.WaitAsync(lifetime.Token).ConfigureAwait(false);
                try
                {
                    if (ended) return;
                    if (retrying != unanswered || State.Token != token) continue;
                    var renewed = await RenewCoreAsync().ConfigureAwait(false);
                    if (renewed is not null && retrying && State.User is null)
                    {
                        try { Set(renewed, await validate(renewed, lifetime.Token).ConfigureAwait(false)); }
                        catch (TransportError error) when (error.Code == ProtocolFacts.Error(401)) { await EndAsync("refused", "credential-refused").ConfigureAwait(false); }
                        catch (SemiontError error) { Report("auth-failed", error); }
                    }
                }
                finally { operations.Release(); }
                step = unanswered ? Math.Min(step * 2, ProtocolFacts.Timing("maxReconnectMs").GetDouble()) : ProtocolFacts.Timing("reconnectMs").GetDouble();
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested)
        {
            // Disposal ends the scheduler; it is not a session failure.
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed != 0) return;
            disposed = 1;
        }
        lifetime.Cancel();
        issuer?.Dispose();
        states.Close();
        errors.Close();
    }
}
