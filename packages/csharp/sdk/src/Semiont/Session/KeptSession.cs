using System.Threading.Channels;
using Semiont.Errors;
using Semiont.Http;
using Semiont.Protocol;
using Semiont.SignIn;
using Semiont.Types;

namespace Semiont.Session;

internal sealed record SessionState(string? Token, UserResponse? User);

internal sealed class KeptSession : IDisposable, IAsyncDisposable
{
    private readonly ISignInKept kept;
    private readonly TimeProvider clock;
    private readonly Random random;
    private readonly Func<string?, CancellationToken, Task<string?>> renew;
    // Null for a session told to ask nobody who its token is.
    private readonly Func<string, CancellationToken, Task<UserResponse>>? validate;
    private readonly Issuer? issuer;
    private readonly Action<SessionEndReason>? onAuthFailed;
    private readonly bool offline;
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim operations = new(1, 1);
    private readonly object gate = new();
    private readonly Broadcast<SessionState> states = new(replayLatest: true);
    private readonly Broadcast<SemiontError> errors;
    private readonly Channel<bool> changed = Channel.CreateUnbounded<bool>();
    private readonly Task ready;
    private Task<string?>? renewal;
    private SessionState state = new(null, null);
    // The token each renewal is handed: the one the session holds, the one found stored at the start though it has
    // expired, or, once a renewal that got no answer has left the session none, the one that renewal was for.
    private string? renewing;
    // The issuer's renewal under way. A disposal does not end it: an issuer that rotates refresh tokens spends the old one
    // as it answers, so the renewal runs to its end, and what it brings is kept where the sign-in is.
    private Task<string?>? issuing;
    private volatile bool unanswered;
    private volatile bool ended;
    // Completed, under the gate, as the session is disposed.
    private readonly TaskCompletionSource disposal = new(Spawning.CompletionOptions);
    // The close, begun with the disposal: it ends once the issuer's renewal under way has ended and the issuer is let go.
    private Task? closing;

    /// <summary>
    /// <paramref name="errors"/> is the session's errors stream, which its client's persistence and its transport also say
    /// what went wrong on; a session that <paramref name="validates"/> asks the gateway who its token is, and
    /// <paramref name="answered"/> is given each token the gateway names a person for, and that person, before the
    /// session holds the answer. <paramref name="onAuthFailed"/> is told why the session ended as it signs out: once its
    /// sign-in is forgotten, before the error that says so.
    /// </summary>
    internal KeptSession(HttpEndpoint endpoint, ISignInKept kept, HttpClient? httpClient, TimeProvider? timeProvider, Random? random,
        Broadcast<SemiontError> errors, bool validates, Func<string, UserResponse, CancellationToken, Task> answered,
        Action<SessionEndReason>? onAuthFailed)
    {
        string origin;
        try { origin = Gateway.Origin(endpoint); }
        catch (Exception error) when (error is SignInError or System.Text.Json.JsonException)
        { throw new SessionError(ProtocolFacts.SessionError("construct-failed"), "The knowledge-base endpoint is invalid", error); }
        this.kept = kept;
        this.errors = errors;
        this.onAuthFailed = onAuthFailed;
        clock = timeProvider ?? TimeProvider.System;
        this.random = random ?? Random.Shared;
        issuer = new Issuer(httpClient, clock, this.random);
        renew = (holding, cancellation) => issuer.RenewAsync(kept, holding, cancellation);
        if (validates)
        {
            validate = async (token, cancellation) =>
            {
                var user = await Gateway.GetCurrentUserAsync(origin, token, httpClient, clock, cancellation).ConfigureAwait(Spawning.Captures);
                await answered(token, user, cancellation).ConfigureAwait(Spawning.Captures);
                return user;
            };
        }
        states.Publish(state);
        ready = Spawning.Run(StartAsync);
    }

    internal KeptSession(ISignInKept kept, Func<string?, CancellationToken, Task<string?>> renew,
        Func<string, CancellationToken, Task<UserResponse>> validate, TimeProvider clock, Random random,
        Action<SessionEndReason>? onAuthFailed, bool offline = false)
    {
        this.kept = kept;
        errors = new(keptForFirst: SemiontError.KeptForFirstReader);
        this.onAuthFailed = onAuthFailed;
        this.offline = offline;
        this.renew = renew;
        this.validate = validate;
        this.clock = clock;
        this.random = random;
        states.Publish(state);
        ready = Spawning.Run(StartAsync);
    }

    public SessionState State => Volatile.Read(ref state);
    public IAsyncEnumerable<SessionState> States(CancellationToken cancellation = default) => states.Observe(cancellation);
    public IAsyncEnumerable<SemiontError> Errors(CancellationToken cancellation = default) => errors.Observe(cancellation);
    public Task ReadyAsync(CancellationToken cancellation = default) => Spawning.WaitAsync(ready, cancellation);

    /// <summary>Says <paramref name="error"/>, a failure of the transport the session's token is sent by, on its errors.</summary>
    internal void Say(SemiontError error) => errors.Publish(error);

    /// <summary>
    /// The gateway refused <paramref name="refused"/>: the token renewed, or the one held for a token already replaced.
    /// Refusals that arrive together share one renewal. Once the session is disposed, a refusal of any token is given no
    /// token and nothing is renewed, and one waiting on a renewal as the session is disposed is given none at once.
    /// </summary>
    public async Task<string?> RefreshAsync(string? refused, CancellationToken cancellation = default)
    {
        Task<string?> shared;
        lock (gate)
        {
            // A disposed session renews nothing, whatever token was refused.
            if (disposal.Task.IsCompleted) return null;
            if (offline) return State.Token == refused ? null : State.Token;
            if (renewal is null || renewal.IsCompleted) renewal = Spawning.Run(() => RefusedAsync(refused));
            shared = renewal;
        }
        return await SharedRenewal.AnswerAsync(shared, disposal.Task, cancellation).ConfigureAwait(Spawning.Captures);
    }

    internal void SetOfflineToken(string? token)
    {
        if (!offline) throw new InvalidOperationException("Only an offline session accepts a test token.");
        Set(token, null);
    }

    private void Set(string? token, UserResponse? user)
    {
        lock (gate)
        {
            if (disposal.Task.IsCompleted) return;
            var next = new SessionState(token, user);
            if (token is not null) renewing = token;
            Volatile.Write(ref state, next);
            states.Publish(next);
            changed.Writer.TryWrite(true);
        }
    }

    private void Report(string name, Exception? cause = null) => errors.Publish(new SessionError(ProtocolFacts.SessionError(name), cause?.Message ?? name, cause));

    private async Task EndAsync(SessionEndReason reason, string code)
    {
        unanswered = false;
        ended = true;
        Set(null, null);
        await ForgetStoredAsync().ConfigureAwait(Spawning.Captures);
        onAuthFailed?.Invoke(reason);
        Report(code);
    }

    private async Task ForgetStoredAsync()
    {
        try { await kept.ForgetAsync(lifetime.Token).ConfigureAwait(Spawning.Captures); }
        catch (Exception error) when (error is not OperationCanceledException) { Report("auth-failed", error); }
    }

    private async Task<string?> RenewCoreAsync(bool starting = false)
    {
        if (ended) return null;
        try
        {
            var token = await IssuedAsync().ConfigureAwait(Spawning.Captures);
            unanswered = false;
            if (token is not null)
            {
                Set(token, State.User);
                return token;
            }
            if (await kept.HeldAsync(lifetime.Token).ConfigureAwait(Spawning.Captures) is null)
            {
                ended = true;
                Set(null, null);
                return null;
            }
        }
        catch (SignInError error) when (!ProtocolFacts.RetryRefresh(error.Status))
        {
            ThrowIfDisposed();
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            ThrowIfDisposed();
            // No answer: the issuer did not give one, or the sign-in could not be read or kept after it did. Never publish
            // an unkept grant.
            unanswered = true;
            Set(null, State.User);
            Report(starting ? "auth-failed" : "refresh-exhausted", error);
            return null;
        }
        // The issuer refused the renewal, or it gave no token while the sign-in is still kept. At the start there was no
        // session to end: the sign-in is forgotten, and nothing is said.
        if (starting)
        {
            ended = true;
            Set(null, null);
            await ForgetStoredAsync().ConfigureAwait(Spawning.Captures);
        }
        else await EndAsync(SessionEndReason.Expired, "refresh-exhausted").ConfigureAwait(Spawning.Captures);
        return null;
    }

    /// <summary>
    /// The issuer's renewal of the token the session holds, which a disposal lets run to its end: what it brings is kept
    /// where the sign-in is. A session disposed before the renewal starts asks the issuer nothing; one disposed before it
    /// ends takes nothing from it, and decides nothing on how it ended. Either is the disposal's cancellation.
    /// </summary>
    private async Task<string?> IssuedAsync()
    {
        Task<string?> issued;
        lock (gate)
        {
            ThrowIfDisposed();
            var holding = renewing;
            issued = issuing = Spawning.Run(() => renew(holding, CancellationToken.None));
        }
        try
        {
            var token = await issued.ConfigureAwait(Spawning.Captures);
            if (!disposal.Task.IsCompleted) return token;
        }
        catch (Exception) when (disposal.Task.IsCompleted)
        {
            // How the renewal ended is no longer the session's to decide.
        }
        throw new OperationCanceledException(lifetime.Token);
    }

    // Once the session is disposed, how a renewal ended decides nothing: the work ends as the disposal's cancellation.
    private void ThrowIfDisposed()
    {
        if (disposal.Task.IsCompleted) throw new OperationCanceledException(lifetime.Token);
    }

    private async Task StartAsync()
    {
        await Spawning.WaitAsync(operations, lifetime.Token).ConfigureAwait(Spawning.Captures);
        try
        {
            var found = await kept.HeldAsync(lifetime.Token).ConfigureAwait(Spawning.Captures);
            if (offline) { Set(found?.Access, null); return; }
            if (found is null) { ended = true; return; }
            lock (gate) renewing = found.Access;
            var issued = Tokens.IsTokenExpired(found.Access, clock.GetUtcNow().ToUnixTimeMilliseconds() / 1000d);
            var token = issued ? await RenewCoreAsync(starting: true).ConfigureAwait(Spawning.Captures) : found.Access;
            if (token is null) return;
            Set(token, null);
            if (validate is null) return;
            for (var ask = 0; ask < 2; ask++)
            {
                try
                {
                    var user = await validate(token, lifetime.Token).ConfigureAwait(Spawning.Captures);
                    Set(token, user);
                    return;
                }
                catch (TransportError error) when (error.Code == ProtocolFacts.Error(401))
                {
                    if (issued) { await EndAsync(SessionEndReason.Refused, "credential-refused").ConfigureAwait(Spawning.Captures); return; }
                    token = await RenewCoreAsync().ConfigureAwait(Spawning.Captures);
                    if (token is null) return;
                    issued = true;
                }
                catch (SemiontError error) { Report("auth-failed", error); return; }
            }
        }
        finally
        {
            operations.Release();
            if (!offline && !disposal.Task.IsCompleted) _ = ScheduleAsync();
        }
    }

    private async Task<string?> RefusedAsync(string? refused)
    {
        await ready.ConfigureAwait(Spawning.Captures);
        await Spawning.WaitAsync(operations, lifetime.Token).ConfigureAwait(Spawning.Captures);
        try
        {
            if (ended) return null;
            if (State.Token != refused) return State.Token;
            var token = await RenewCoreAsync().ConfigureAwait(Spawning.Captures);
            if (token is null || validate is null) return token;
            try { Set(token, await validate(token, lifetime.Token).ConfigureAwait(Spawning.Captures)); }
            catch (TransportError error) when (error.Code == ProtocolFacts.Error(401))
            { await EndAsync(SessionEndReason.Refused, "credential-refused").ConfigureAwait(Spawning.Captures); }
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
                    await changed.Reader.ReadAsync(lifetime.Token).ConfigureAwait(Spawning.Captures);
                    continue;
                }
                var delay = retrying ? Retry.EqualJitter(TimeSpan.FromMilliseconds(step), random) : TimeSpan.FromSeconds(seconds ?? throw new InvalidOperationException("No renewal delay"));
                using var waiting = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                var timer = Task.Delay(delay, clock, waiting.Token);
                var change = Spawning.AsTask(changed.Reader.WaitToReadAsync(waiting.Token));
                var completed = await Spawning.WhenAny(timer, change).ConfigureAwait(Spawning.Captures);
                await Spawning.CancelAsync(waiting).ConfigureAwait(Spawning.Captures);
                if (completed != timer) continue;
                await timer.ConfigureAwait(Spawning.Captures);
                await Spawning.WaitAsync(operations, lifetime.Token).ConfigureAwait(Spawning.Captures);
                try
                {
                    if (ended) return;
                    if (retrying != unanswered || State.Token != token) continue;
                    var renewed = await RenewCoreAsync().ConfigureAwait(Spawning.Captures);
                    if (renewed is not null && retrying && State.User is null && validate is not null)
                    {
                        try { Set(renewed, await validate(renewed, lifetime.Token).ConfigureAwait(Spawning.Captures)); }
                        catch (TransportError error) when (error.Code == ProtocolFacts.Error(401)) { await EndAsync(SessionEndReason.Refused, "credential-refused").ConfigureAwait(Spawning.Captures); }
                        catch (SemiontError error) { Report("auth-failed", error); }
                    }
                }
                finally { operations.Release(); }
                // Only a renewal on the backoff that got no answer doubles the step: the first after any other waits the
                // jitter of reconnectMs.
                step = retrying && unanswered ? Math.Min(step * 2, ProtocolFacts.Timing("maxReconnectMs").GetDouble()) : ProtocolFacts.Timing("reconnectMs").GetDouble();
            }
        }
        catch (OperationCanceledException) when (disposal.Task.IsCompleted)
        {
            // Disposal ends the scheduler; it is not a session failure.
        }
    }

    /// <summary>
    /// End the session: each refusal waiting is given no token, and its waits end. The issuer's renewal under way runs to
    /// its end, and the issuer is let go after it.
    /// </summary>
    public void Dispose() => _ = CloseAsync();

    /// <summary>End the session, and wait for the issuer's renewal under way to end: what it brought is kept where the
    /// sign-in is, and the issuer let go, by the time this returns.</summary>
    public ValueTask DisposeAsync() => new(CloseAsync());

    private Task CloseAsync()
    {
        Task closed;
        lock (gate)
        {
            if (closing is not null) return closing;
            disposal.SetResult();
            var underWay = issuing;
            closing = closed = Spawning.Run(() => ReleaseIssuerAsync(underWay));
        }
        lifetime.Cancel();
        states.Close();
        errors.Close();
        return closed;
    }

    private async Task ReleaseIssuerAsync(Task<string?>? underWay)
    {
        if (underWay is not null) await ((Task)underWay).ConfigureAwait(Spawning.Options(ConfigureAwaitOptions.SuppressThrowing));
        issuer?.Dispose();
    }
}
