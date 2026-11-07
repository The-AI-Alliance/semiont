using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Semiont.Identifiers;
using Semiont.Protocol;
using Semiont.SignIn;
using Semiont.Storage;
using Semiont.Types;

namespace Semiont.Registry;

public static class RegistryStorage
{
    private static readonly JsonElement Table = JsonSerializer.Deserialize<JsonElement>(ProtocolTables.Stored);
    private static readonly string Prefix = Text(Table.GetProperty("sessionKeyPrefix"), "prefix");
    private static readonly string LastEventIdPrefix = Text(Table.GetProperty("lastEventIdKeyPrefix"), "prefix");
    private static readonly string CachePrefix = Text(Table.GetProperty("cacheKeyPrefix"), "prefix");
    public static readonly string KnowledgeBasesKey = Key("knowledgeBasesKey");
    public static readonly string ActiveKey = Key("activeKey");
    public static readonly string OpenResourcesByKbKey = Key("openResourcesByKbKey");
    public static readonly string LastViewedResourceByKbKey = Key("lastViewedResourceByKbKey");
    internal static readonly string PendingKey = Key("pendingAuthorizationKey");
    internal static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static string Key(string member) => Text(Table.GetProperty("keys").EnumerateArray().Single(row => Text(row, "member") == member), "key");
    private static string Text(JsonElement value, string name) => value.GetProperty(name).GetString() ?? throw new InvalidOperationException("Missing " + name);

    /// <summary>
    /// The key what a client keeps for a person is kept under, never their did: the unpadded base64url SHA-256 of the
    /// UTF-8 of <paramref name="did"/>, as the gateway answers who a token is.
    /// </summary>
    public static string PersonKey(UserId did) => Base64Url.EncodeToString(SHA256.HashData(Encoding.UTF8.GetBytes(did.Value)));
    internal static string LastEventIdKey(string kbId, string personKey) => LastEventIdPrefix + kbId + "." + personKey;
    internal static string CacheKey(string kbId, string personKey, string query) => CachePrefix + kbId + "." + personKey + "." + query;

    public static string SessionKey(string kbId) => Prefix + kbId;
    public static string? KbOfSessionKey(string key) => key.StartsWith(Prefix, StringComparison.Ordinal) ? key[Prefix.Length..] : null;
    public static StoredSession? StoredSession(ISessionStorage storage, string kbId) => Read<StoredSession>(storage.Get(SessionKey(kbId)));

    /// <summary>
    /// Saves a new sign-in for <paramref name="kbId"/> in place of the stored one, forgetting what is kept for the person
    /// the replaced one named: a new sign-in names nobody until its gateway names them, even when they are that person.
    /// </summary>
    public static void StoreSession(ISessionStorage storage, string kbId, StoredSession session) =>
        ForgetKept(storage, kbId, SwapStoredSession(storage, kbId, session));

    /// <summary>Forgets <paramref name="kbId"/>'s stored sign-in, and with it what is kept for the person it names.</summary>
    public static void ClearStoredSession(ISessionStorage storage, string kbId) => ForgetKept(storage, kbId, SwapStoredSession(storage, kbId, null));

    /// <summary>
    /// Puts <paramref name="replacement"/> in place of <paramref name="kbId"/>'s stored sign-in as one step, storing
    /// nothing for none, and gives back the sign-in it replaced.
    /// </summary>
    internal static StoredSession? SwapStoredSession(ISessionStorage storage, string kbId, StoredSession? replacement)
    {
        StoredSession? replaced = null;
        storage.Update(SessionKey(kbId), value =>
        {
            replaced = Read<StoredSession>(value);
            return replacement is null ? null : Write(replacement);
        });
        return replaced;
    }

    /// <summary>
    /// Deletes what is kept on one knowledge base for the person a forgotten saved sign-in named, as forgetting it does:
    /// the key of every persisted query and the stream's. A sign-in that named nobody, or none, deletes nothing.
    /// </summary>
    internal static void ForgetKept(ISessionStorage storage, string kbId, StoredSession? forgotten)
    {
        if (forgotten is not { PersonKey: { } personKey }) return;
        foreach (var query in LiveQueries.PersistedQueries) storage.Delete(CacheKey(kbId, personKey, query));
        storage.Delete(LastEventIdKey(kbId, personKey));
    }

    public static IReadOnlyList<KnowledgeBase> LoadKnowledgeBases(ISessionStorage storage) => ReadKnowledgeBases(storage.Get(KnowledgeBasesKey));
    public static void SaveKnowledgeBases(ISessionStorage storage, IReadOnlyList<KnowledgeBase> kbs) => storage.Set(KnowledgeBasesKey, Write(kbs));
    public static ISignInKept KeptIn(ISessionStorage storage, string kbId) => new RegistrySignIn(storage, kbId, () => ClearStoredSession(storage, kbId));

    /// <summary>
    /// What holds a registry session's sign-in in the storage its client keeps in: forgetting it waits for a save of the
    /// client's persistence already being written, and ends its saves.
    /// </summary>
    internal static ISignInKept KeptFor(CachePersistence persistence) =>
        new RegistrySignIn(persistence.Storage, persistence.KbId, persistence.Forget);

    internal static IReadOnlyList<KnowledgeBase> ReadKnowledgeBases(string? json)
    {
        var values = Read<JsonElement[]>(json) ?? [];
        var kbs = new List<KnowledgeBase>();
        foreach (var value in values)
        {
            try { if (value.Deserialize<KnowledgeBase>() is { } kb) kbs.Add(kb); }
            catch (JsonException) { /* Other entries still belong to the registry. */ }
        }
        return kbs.AsReadOnly();
    }

    internal static T? Read<T>(string? json) where T : class
    {
        if (json is null) return null;
        try { return JsonSerializer.Deserialize<T>(json, Json); }
        catch (JsonException) { return null; }
    }

    internal static string Write<T>(T value) => JsonSerializer.Serialize(value, Json);

    /// <summary><paramref name="forget"/> forgets the stored sign-in and what is kept for the person it names.</summary>
    private sealed class RegistrySignIn(ISessionStorage storage, string kbId, Action forget) : ISignInKept
    {
        public Task<StoredSession?> HeldAsync(CancellationToken cancellation = default)
        {
            cancellation.ThrowIfCancellationRequested();
            return Task.FromResult(StoredSession(storage, kbId));
        }

        public Task KeepAsync(StoredSession signIn, CancellationToken cancellation = default)
        {
            cancellation.ThrowIfCancellationRequested();
            StoreSession(storage, kbId, signIn);
            return Task.CompletedTask;
        }

        public Task ForgetAsync(CancellationToken cancellation = default)
        {
            cancellation.ThrowIfCancellationRequested();
            forget();
            return Task.CompletedTask;
        }

        public Task<string?> RenewedAsync(StoredSession read, string access, string refresh, CancellationToken cancellation = default)
        {
            cancellation.ThrowIfCancellationRequested();
            string? adopted = null;
            storage.Update(SessionKey(kbId), value =>
            {
                if (Read<StoredSession>(value) is not { } stored) return value;
                if (stored.Access != read.Access || stored.Refresh != read.Refresh) { adopted = stored.Access; return value; }
                adopted = access;
                return Write(stored with { Access = access, Refresh = refresh });
            });
            return Task.FromResult(adopted);
        }

        public Task<bool> RecordPersonKeyAsync(string access, string personKey, CancellationToken cancellation = default)
        {
            cancellation.ThrowIfCancellationRequested();
            var recorded = false;
            storage.Update(SessionKey(kbId), value =>
            {
                if (Read<StoredSession>(value) is not { } stored || stored.Access != access) return value;
                if (stored.PersonKey is { } named) { recorded = named == personKey; return value; }
                recorded = true;
                return Write(stored with { PersonKey = personKey });
            });
            return Task.FromResult(recorded);
        }
    }
}

public sealed record OpenResource(
    [property: JsonRequired] ResourceId Id,
    [property: JsonRequired] string Name,
    [property: JsonRequired] long OpenedAt,
    [property: JsonRequired] int Order,
    string? MediaType = null, string? StorageUri = null);

public enum TabVerdict { Gone, Ready, Unknown }
public sealed record TabCheck(TabVerdict Verdict, string? Name = null, string? MediaType = null);

public static class OpenResources
{
    public static IReadOnlyList<OpenResource> SortOpenResources(IReadOnlyList<OpenResource> resources) =>
        Array.AsReadOnly(resources.OrderBy(tab => tab.Order).ThenBy(tab => tab.OpenedAt).ToArray());

    public static IReadOnlyList<OpenResource> ApplyTabChecks(IReadOnlyList<OpenResource> opened, IReadOnlyDictionary<ResourceId, TabCheck> checks)
    {
        var tabs = new List<OpenResource>();
        foreach (var tab in opened)
        {
            var check = checks.GetValueOrDefault(tab.Id);
            if (check?.Verdict == TabVerdict.Gone) continue;
            tabs.Add(check is { Verdict: TabVerdict.Ready, Name: { } name }
                ? tab with { Name = name, MediaType = check.MediaType ?? tab.MediaType } : tab);
        }
        return tabs.AsReadOnly();
    }
}
