using System.Text.Json;
using Semiont.Errors;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont.SignIn;

public sealed class Issuer : IDisposable
{
    private readonly HttpClient? client;
    private readonly HttpMessageInvoker? owned;
    private readonly TimeProvider clock;
    private readonly Random random;
    private readonly CancellationTokenSource lifetime = new();

    public Issuer(HttpClient? httpClient = null, TimeProvider? timeProvider = null, Random? random = null)
    {
        client = httpClient;
        if (client is null) owned = new HttpMessageInvoker(new SocketsHttpHandler { UseProxy = false });
        clock = timeProvider ?? TimeProvider.System;
        this.random = random ?? Random.Shared;
    }

    public Task<string?> RenewAsync(ISignInKept kept, string? holding, CancellationToken cancellation = default)
    {
        lifetime.Token.ThrowIfCancellationRequested();
        return KeptRenewal.RenewAsync(kept, holding, RefreshAsync, clock, cancellation);
    }

    private async Task<(string Access, string? Refresh)> RefreshAsync(StoredSession held, CancellationToken cancellation)
    {
        var budget = ProtocolFacts.Timing("refreshRetry");
        var attempts = budget.GetProperty("attempts").GetInt32();
        var delay = budget.GetProperty("initialDelayMs").GetDouble();
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token);
        for (var attempt = 1; ; attempt++)
        {
            try { return await GrantAsync(held, linked.Token).ConfigureAwait(false); }
            catch (SignInError error) when (attempt < attempts && ProtocolFacts.RetryRefresh(error.Status))
            {
                await Task.Delay(TimeSpan.FromMilliseconds(delay / 2 + random.NextDouble() * delay / 2), clock, linked.Token).ConfigureAwait(false);
                delay = Math.Min(delay * 2, budget.GetProperty("maxDelayMs").GetDouble());
            }
        }
    }

    private async Task<(string Access, string? Refresh)> GrantAsync(StoredSession held, CancellationToken cancellation)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, held.TokenEndpoint);
        request.Headers.Accept.ParseAdd("application/json");
        request.Content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = held.Refresh,
            ["client_id"] = held.ClientId,
        });
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(ProtocolFacts.Timing("httpRequestTimeoutMs").GetDouble()), clock);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, deadline.Token);
        int? status = null;
        try
        {
            using var response = client is not null
                ? await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token).ConfigureAwait(false)
                : await (owned ?? throw new InvalidOperationException("No issuer HTTP handler")).SendAsync(request, linked.Token).ConfigureAwait(false);
            status = (int)response.StatusCode;
            if (status != 200) throw Failure("The issuer refused the refresh grant", status);
            await using var body = await response.Content.ReadAsStreamAsync(linked.Token).ConfigureAwait(false);
            using var answer = await JsonDocument.ParseAsync(body, cancellationToken: linked.Token).ConfigureAwait(false);
            var root = answer.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("access_token", out var access) || access.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(access.GetString()))
                throw Failure("The issuer answered without an access token", status);
            string? refresh = null;
            if (root.TryGetProperty("refresh_token", out var stated))
            {
                if (stated.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(stated.GetString())) throw Failure("The issuer answered with an invalid refresh token", status);
                refresh = stated.GetString();
            }
            return (access.GetString() ?? throw Failure("The issuer answered without an access token", status), refresh);
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { throw Failure("The issuer did not answer before the deadline", null); }
        catch (HttpRequestException error) { throw Failure("The issuer did not answer", null, error); }
        catch (JsonException error) { throw Failure("The issuer answered with invalid JSON", status, error); }
    }

    private static SignInError Failure(string message, int? status, Exception? inner = null) => new(ProtocolFacts.SignInError("exchange"), message, status, inner);

    public void Dispose() { lifetime.Cancel(); owned?.Dispose(); }
}
