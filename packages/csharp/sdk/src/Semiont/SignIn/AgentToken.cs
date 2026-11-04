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
    private bool disposed;

    public AgentToken(HttpEndpoint endpoint, ServiceToken service, HttpClient? httpClient = null, TimeProvider? timeProvider = null)
    {
        Gateway = Session.Gateway.Origin(endpoint);
        this.service = service;
        client = httpClient;
        clock = timeProvider ?? TimeProvider.System;
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
            ObjectDisposedException.ThrowIf(disposed, this);
            if (started) throw new InvalidOperationException("An agent signs in once");
            started = true;
        }
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token);
        var access = await service.TokenAsync(null, false, linked.Token).ConfigureAwait(false);
        var user = await Session.Gateway.GetCurrentUserAsync(Gateway, access, client, clock, linked.Token).ConfigureAwait(false);
        lock (gate)
        {
            linked.Token.ThrowIfCancellationRequested();
            ObjectDisposedException.ThrowIf(disposed, this);
            did = user.Did;
            Publish(access);
        }
    }

    public async Task<string?> RefreshAsync(string? refused, CancellationToken cancellation = default)
    {
        cancellation.ThrowIfCancellationRequested();
        try { return await Renewal(refused, false).WaitAsync(cancellation).ConfigureAwait(false); }
        catch (SignInError) { return null; }
    }

    private Task<string?> Renewal(string? refused, bool retry)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (token is null || token != refused) return Task.FromResult(token);
            if (renewing is { IsCompleted: false }) return renewing;
            var access = token;
            renewing = Task.Run(() => RenewAsync(access, retry, lifetime.Token));
            return renewing;
        }
    }

    private async Task<string?> RenewAsync(string refused, bool retry, CancellationToken cancellation)
    {
        var access = await service.TokenAsync(refused, retry, cancellation).ConfigureAwait(false);
        lock (gate)
        {
            cancellation.ThrowIfCancellationRequested();
            if (!disposed && token == refused)
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
            await Task.Delay(TimeSpan.FromSeconds(Math.Min(delay, (uint.MaxValue - 1d) / 1000)), clock, timer.Token).ConfigureAwait(false);
            lock (gate)
            {
                if (scheduled != timer || disposed) return;
                scheduled = null;
            }
            await Renewal(access, true).ConfigureAwait(false);
        }
        catch (ObjectDisposedException) when (disposed)
        {
            // Disposal won the race to start a renewal.
        }
        catch (SignInError)
        {
            lock (gate)
            {
                if (!disposed && token == access && scheduled is null) Schedule(access);
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
            if (disposed) return;
            disposed = true;
            scheduled = null;
            tokens.Close();
        }
        lifetime.Cancel();
    }
}
