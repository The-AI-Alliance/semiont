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

    internal static string CacheKey(string kbId, UserId user) => "semiont.cache.csharp.v1." +
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new[] { kbId, user.Value })));

    public static string SessionKey(string kbId) => Prefix + kbId;
    public static string? KbOfSessionKey(string key) => key.StartsWith(Prefix, StringComparison.Ordinal) ? key[Prefix.Length..] : null;
    public static StoredSession? StoredSession(ISessionStorage storage, string kbId) => Read<StoredSession>(storage.Get(SessionKey(kbId)));
    public static void StoreSession(ISessionStorage storage, string kbId, StoredSession session) => storage.Set(SessionKey(kbId), Write(session));
    public static void ClearStoredSession(ISessionStorage storage, string kbId) => storage.Delete(SessionKey(kbId));

    public static IReadOnlyList<KnowledgeBase> LoadKnowledgeBases(ISessionStorage storage) => ReadKnowledgeBases(storage.Get(KnowledgeBasesKey));
    public static void SaveKnowledgeBases(ISessionStorage storage, IReadOnlyList<KnowledgeBase> kbs) => storage.Set(KnowledgeBasesKey, Write(kbs));
    public static ISignInKept KeptIn(ISessionStorage storage, string kbId) => new RegistrySignIn(storage, kbId);

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

    private sealed class RegistrySignIn(ISessionStorage storage, string kbId) : ISignInKept
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
            ClearStoredSession(storage, kbId);
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
