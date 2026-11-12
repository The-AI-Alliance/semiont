using Semiont.Errors;
using Semiont.Http;
using Semiont.Identifiers;
using Semiont.Session;
using Semiont.Types;

namespace Semiont.SignIn;

public sealed class AgentToken : IDisposable
{
    private readonly ServiceToken service;
    private readonly HttpClient? client;
    private readonly TimeProvider clock;
    private readonly CancellationTokenSource lifetime = new();
    private readonly Broadcast<string> tokens = new(replayLatest: true);
    private readonly object gate = new();
    private CancellationTokenSource? scheduled;
    private Task<string?>? renewing;
    private string? token;
    private UserId? did;
    private bool started;
    // Completed, under the gate, as the agent is disposed.
    private readonly TaskCompletionSource disposal = new(Spawning.CompletionOptions);

    public AgentToken(HttpEndpoint endpoint, ServiceToken service, HttpClient? httpClient = null)
    {
        Gateway = Session.Gateway.Origin(endpoint);
        this.service = service;
        client = httpClient;
        clock = service.Clock;
    }

    public string Gateway { get; }
    public string? Token { get { lock (gate) return token; } }
    public UserId? Did { get { lock (gate) return did; } }
    public IAsyncEnumerable<string> TokensChanged(CancellationToken cancellation = default) => tokens.Observe(cancellation);

    public async Task SignInAsync(CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposal.Task.IsCompleted, this);
            if (started) throw new InvalidOperationException("An agent signs in once");
            started = true;
        }
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token);
        var access = await service.TokenAsync(null, false, linked.Token).ConfigureAwait(Spawning.Captures);
        var user = await Session.Gateway.GetCurrentUserAsync(Gateway, access, client, clock, linked.Token).ConfigureAwait(Spawning.Captures);
        lock (gate)
        {
            linked.Token.ThrowIfCancellationRequested();
            ObjectDisposedException.ThrowIf(disposal.Task.IsCompleted, this);
            did = user.Did;
            Publish(access);
        }
    }

    /// <summary>
    /// The gateway refused <paramref name="refused"/>: the token renewed, or, for a token already replaced, the one held,
    /// with the issuer not asked. A refusal while the token held is renewed joins that renewal. Once the agent is
    /// disposed, a refusal of any token is given no token and the issuer is not asked, and one waiting on the renewal the
    /// disposal ended is given none at once.
    /// </summary>
    public async Task<string?> RefreshAsync(string? refused, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        try { return await SharedRenewal.AnswerAsync(Renewal(refused, false), disposal.Task, cancellation).ConfigureAwait(Spawning.Captures); }
        catch (SignInError) { return null; }
    }

    private Task<string?> Renewal(string? refused, bool retry)
    {
        lock (gate)
        {
            // A disposed agent renews nothing, whatever token was refused.
            if (disposal.Task.IsCompleted) return Task.FromResult<string?>(null);
            if (token != refused) return Task.FromResult(token);
            if (renewing is { IsCompleted: false }) return renewing;
            renewing = Spawning.Run(() => RenewAsync(refused, retry, lifetime.Token));
            return renewing;
        }
    }

    private async Task<string?> RenewAsync(string? refused, bool retry, CancellationToken cancellation)
    {
        var access = await service.TokenAsync(refused, retry, cancellation).ConfigureAwait(Spawning.Captures);
        lock (gate)
        {
            // The disposal ended this renewal: the token it brings is not taken.
            if (disposal.Task.IsCompleted) return null;
            if (token == refused)
            {
                renewing = null;
                Publish(access);
            }
            return token;
        }
    }

    private void Publish(string access)
    {
        token = access;
        tokens.Publish(access);
        Schedule(access);
    }

    private void Schedule(string access)
    {
        scheduled?.Cancel();
        scheduled = null;
        var seconds = Tokens.RefreshDelay(access, clock.GetUtcNow().ToUnixTimeMilliseconds() / 1000d);
        if (seconds is not double delay) return;
        scheduled = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        _ = RenewWhenDueAsync(access, delay, scheduled);
    }

    private async Task RenewWhenDueAsync(string access, double delay, CancellationTokenSource timer)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(Math.Min(delay, (uint.MaxValue - 1d) / 1000)), clock, timer.Token).ConfigureAwait(Spawning.Captures);
            lock (gate)
            {
                if (scheduled != timer || disposal.Task.IsCompleted) return;
                scheduled = null;
            }
            await Renewal(access, true).ConfigureAwait(Spawning.Captures);
        }
        catch (SignInError)
        {
            lock (gate)
            {
                if (!disposal.Task.IsCompleted && token == access && scheduled is null) Schedule(access);
            }
        }
        catch (OperationCanceledException) when (timer.IsCancellationRequested)
        {
            // A replacement token or disposal superseded this timer.
        }
        finally
        {
            lock (gate) timer.Dispose();
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposal.Task.IsCompleted) return;
            disposal.SetResult();
            scheduled = null;
            tokens.Close();
        }
        lifetime.Cancel();
    }
}
