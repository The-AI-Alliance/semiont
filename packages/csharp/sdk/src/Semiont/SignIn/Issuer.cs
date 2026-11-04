using System.Text.Json;
using Semiont.Errors;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont.SignIn;

public sealed partial class Issuer : IDisposable
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

    private Task<(string Access, string? Refresh)> RefreshAsync(StoredSession held, CancellationToken cancellation) =>
        RetryAsync(token => GrantAsync(held, token), cancellation);

    internal async Task<T> RetryAsync<T>(Func<CancellationToken, Task<T>> grant, CancellationToken cancellation)
    {
        var budget = ProtocolFacts.Timing("refreshRetry");
        var attempts = budget.GetProperty("attempts").GetInt32();
        var delay = budget.GetProperty("initialDelayMs").GetDouble();
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token);
        for (var attempt = 1; ; attempt++)
        {
            try { return await grant(linked.Token).ConfigureAwait(false); }
            catch (SignInError error) when (attempt < attempts && ProtocolFacts.RetryRefresh(error.Status))
            {
                await Task.Delay(TimeSpan.FromMilliseconds(delay / 2 + random.NextDouble() * delay / 2), clock, linked.Token).ConfigureAwait(false);
                delay = Math.Min(delay * 2, budget.GetProperty("maxDelayMs").GetDouble());
            }
        }
    }

    private async Task<(string Access, string? Refresh)> GrantAsync(StoredSession held, CancellationToken cancellation)
    {
        var answer = await AnswerAsync(held.TokenEndpoint, new Dictionary<string, string>
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = held.Refresh,
            ["client_id"] = held.ClientId,
        }, cancellation: cancellation).ConfigureAwait(false);
        if (answer.Status != 200) throw Failure("The issuer refused the refresh grant", answer.Status);
        return Issued(answer);
    }

    private static (string Access, string? Refresh) Issued(IssuerAnswer answer)
    {
        var access = answer.Text("access_token");
        if (string.IsNullOrEmpty(access)) throw Failure("The issuer answered without an access token", answer.Status);
        string? refresh = null;
        if (answer.Body is JsonElement body && body.TryGetProperty("refresh_token", out var stated))
        {
            if (stated.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(stated.GetString())) throw Failure("The issuer answered with an invalid refresh token", answer.Status);
            refresh = stated.GetString();
        }
        return (access, refresh);
    }

    internal sealed record IssuerAnswer(int Status, JsonElement? Body)
    {
        internal string? Text(string name) => Body is JsonElement body && body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        internal double? Seconds(string name) => Body is JsonElement body && body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var seconds) && seconds >= 0 && double.IsFinite(seconds) ? seconds : null;
    }

    internal async Task<IssuerAnswer> AnswerAsync(string url, Dictionary<string, string>? form = null,
        string errorCode = "exchange", CancellationToken cancellation = default)
    {
        lifetime.Token.ThrowIfCancellationRequested();
        using var request = new HttpRequestMessage(form is null ? HttpMethod.Get : HttpMethod.Post, url);
        request.Headers.Accept.ParseAdd("application/json");
        if (form is not null) request.Content = new FormUrlEncodedContent(form);
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(ProtocolFacts.Timing("httpRequestTimeoutMs").GetDouble()), clock);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token, deadline.Token);
        int? status = null;
        try
        {
            using var response = client is not null
                ? await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linked.Token).ConfigureAwait(false)
                : await (owned ?? throw new InvalidOperationException("No issuer HTTP handler")).SendAsync(request, linked.Token).ConfigureAwait(false);
            status = (int)response.StatusCode;
            var bytes = await response.Content.ReadAsByteArrayAsync(linked.Token).ConfigureAwait(false);
            if (bytes.Length == 0) return new IssuerAnswer(status.Value, null);
            try
            {
                using var document = JsonDocument.Parse(bytes);
                if (document.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException("The issuer answered with no JSON object");
                return new IssuerAnswer(status.Value, document.RootElement.Clone());
            }
            catch (JsonException) when (!response.IsSuccessStatusCode) { return new IssuerAnswer(status.Value, null); }
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested && !lifetime.IsCancellationRequested)
        { throw new SignInError(ProtocolFacts.SignInError(errorCode), "The issuer did not answer before the deadline"); }
        catch (Exception error) when (error is HttpRequestException or IOException)
        { throw new SignInError(ProtocolFacts.SignInError(errorCode), "The issuer did not answer", inner: error); }
        catch (JsonException error)
        { throw new SignInError(ProtocolFacts.SignInError(errorCode), "The issuer answered with invalid JSON", status, error); }
    }

    private static SignInError Failure(string message, int? status, Exception? inner = null) => new(ProtocolFacts.SignInError("exchange"), message, status, inner);

    public void Dispose() { lifetime.Cancel(); owned?.Dispose(); }
}
