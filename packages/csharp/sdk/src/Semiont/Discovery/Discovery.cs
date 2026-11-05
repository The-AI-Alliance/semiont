using System.Net;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont.Discovery;

[JsonConverter(typeof(JsonStringEnumConverter<DiscoveryAbsentReason>))]
public enum DiscoveryAbsentReason
{
    [JsonStringEnumMemberName("not-found")] NotFound,
    [JsonStringEnumMemberName("not-json")] NotJson,
    [JsonStringEnumMemberName("invalid")] Invalid,
    [JsonStringEnumMemberName("unsupported-version")] UnsupportedVersion,
    [JsonStringEnumMemberName("unreadable")] Unreadable,
}

public abstract record DiscoveryRead;
public abstract record DiscoveryState : DiscoveryRead;
public sealed record Absent(DiscoveryAbsentReason Reason, string? Diagnostic = null) : DiscoveryState;
public sealed record Managed(IReadOnlyList<DiscoveredKB> Kbs) : DiscoveryState;
public sealed record Unchanged : DiscoveryRead;

public interface DiscoveryTransport
{
    public Task<DiscoveryRead> ReadAsync(CancellationToken cancellation = default);
}

public sealed record DiscoveryDiff(DiscoveryState State, IReadOnlyList<DiscoveredKB> Added,
    IReadOnlyList<DiscoveredKB> Updated, IReadOnlyList<DiscoveredKB> Removed, IReadOnlyList<string> Duplicated);

public static class LauncherDiscovery
{
    public static readonly TimeSpan DiscoveryInterval = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("discoveryIntervalMs").GetInt32());
    private static readonly TimeSpan RequestDeadline = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("httpRequestTimeoutMs").GetInt32());
    private static readonly long Version = JsonSerializer.Deserialize<JsonElement>(ProtocolTables.Discovery)
        .GetProperty("properties").GetProperty("version").GetProperty("enum").EnumerateArray().Single().GetInt64();
    private static readonly HttpClient SharedHttp = new(new SocketsHttpHandler { UseProxy = false });

    public static DiscoveryState ParseDiscoveryDocument(string text)
    {
        JsonDocument parsed;
        try { parsed = JsonDocument.Parse(text); }
        catch (JsonException error) { return new Absent(DiscoveryAbsentReason.NotJson, error.Message); }
        using (parsed)
        {
            var root = parsed.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("version", out var stated) ||
                stated.ValueKind != JsonValueKind.Number || !stated.TryGetInt64(out var version))
                return new Absent(DiscoveryAbsentReason.Invalid, "A discovery document requires a numeric version.");
            if (version != Version)
                return new Absent(DiscoveryAbsentReason.UnsupportedVersion, $"Discovery document version {version} is unsupported.");
            try
            {
                var document = root.Deserialize<DiscoveryDocument>() ?? throw new JsonException("Missing discovery document.");
                foreach (var kb in document.Kbs)
                    if (kb.Port is < 1 or > 65535) throw new JsonException($"Invalid port for {kb.Host}.");
                return new Managed(document.Kbs);
            }
            catch (JsonException error) { return new Absent(DiscoveryAbsentReason.Invalid, error.Message); }
        }
    }

    public static DiscoveryTransport TextDiscovery(Func<CancellationToken, Task<string>> readText) => new TextReader(readText);

    public static DiscoveryTransport HttpDiscovery(string url, HttpClient? httpClient = null, TimeProvider? timeProvider = null) =>
        new HttpReader(url, httpClient ?? SharedHttp, timeProvider ?? TimeProvider.System);

    public static async IAsyncEnumerable<DiscoveryDiff> SubscribeDiscovery(DiscoveryTransport transport, TimeSpan? interval = null,
        TimeProvider? timeProvider = null, [EnumeratorCancellation] CancellationToken cancellation = default)
    {
        var delay = interval ?? DiscoveryInterval;
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(delay, TimeSpan.Zero);
        var clock = timeProvider ?? TimeProvider.System;
        DiscoveryState? previous = null;
        while (true)
        {
            cancellation.ThrowIfCancellationRequested();
            if (await transport.ReadAsync(cancellation).ConfigureAwait(false) is DiscoveryState state && Difference(previous, state) is { } change)
            {
                previous = state;
                yield return change;
            }
            await Task.Delay(delay, clock, cancellation).ConfigureAwait(false);
        }
    }

    internal static DiscoveryDiff? Difference(DiscoveryState? previous, DiscoveryState current)
    {
        static string Address(DiscoveredKB kb) => kb.Host + ":" + kb.Port.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var old = previous is Managed before ? before.Kbs.ToLookup(Address, StringComparer.Ordinal) : Enumerable.Empty<DiscoveredKB>().ToLookup(Address);
        var now = current is Managed after ? after.Kbs.ToLookup(Address, StringComparer.Ordinal) : Enumerable.Empty<DiscoveredKB>().ToLookup(Address);
        var added = now.Where(group => !old.Contains(group.Key)).SelectMany(group => group).ToArray();
        var removed = old.Where(group => !now.Contains(group.Key)).SelectMany(group => group).ToArray();
        var updated = now.Where(group => old.Contains(group.Key) && !SameEntries(old[group.Key], group)).SelectMany(group => group).ToArray();
        var changed = previous is null || previous.GetType() != current.GetType() ||
            previous is Absent oldAbsent && current is Absent newAbsent && oldAbsent.Reason != newAbsent.Reason;
        return changed || added.Length + removed.Length + updated.Length > 0
            ? new DiscoveryDiff(current, added, updated, removed, now.Where(group => group.Count() > 1).Select(group => group.Key).ToArray())
            : null;
    }

    private static bool SameEntries(IEnumerable<DiscoveredKB> previous, IEnumerable<DiscoveredKB> current)
    {
        var unmatched = previous.ToList();
        foreach (var entry in current)
            if (!unmatched.Remove(entry)) return false;
        return unmatched.Count == 0;
    }

    private sealed class TextReader(Func<CancellationToken, Task<string>> read) : DiscoveryTransport
    {
        public async Task<DiscoveryRead> ReadAsync(CancellationToken cancellation = default)
        {
            try { return ParseDiscoveryDocument(await read(cancellation).ConfigureAwait(false)); }
            catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException) { return new Absent(DiscoveryAbsentReason.NotFound); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.DecoderFallbackException)
            { return new Absent(DiscoveryAbsentReason.Unreadable, error.Message); }
        }
    }

    private sealed class HttpReader(string url, HttpClient http, TimeProvider clock) : DiscoveryTransport
    {
        private readonly SemaphoreSlim turn = new(1, 1);
        private EntityTagHeaderValue? tag;

        public async Task<DiscoveryRead> ReadAsync(CancellationToken cancellation = default)
        {
            await turn.WaitAsync(cancellation).ConfigureAwait(false);
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, url);
                if (tag is not null) request.Headers.IfNoneMatch.Add(tag);
                using var deadline = new CancellationTokenSource(RequestDeadline, clock);
                using var waiting = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token, cancellation);
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, waiting.Token).ConfigureAwait(false);
                if (response.StatusCode == HttpStatusCode.NotModified && tag is not null) return new Unchanged();
                tag = null;
                var media = response.Content.Headers.ContentType?.MediaType;
                if (!response.IsSuccessStatusCode || media?.Contains("json", StringComparison.OrdinalIgnoreCase) != true)
                    return new Absent(DiscoveryAbsentReason.NotFound, $"HTTP {(int)response.StatusCode}, content type {media}");
                var state = ParseDiscoveryDocument(await response.Content.ReadAsStringAsync(waiting.Token).ConfigureAwait(false));
                if (state is Managed) tag = response.Headers.ETag;
                return state;
            }
            catch (Exception error) when (error is HttpRequestException or IOException ||
                error is OperationCanceledException && !cancellation.IsCancellationRequested)
            {
                tag = null;
                return new Absent(DiscoveryAbsentReason.Unreadable, error.Message);
            }
            finally { turn.Release(); }
        }
    }
}
