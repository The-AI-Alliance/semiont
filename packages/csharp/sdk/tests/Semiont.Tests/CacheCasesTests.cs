using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Semiont.Identifiers;
using Semiont.Registry;
using Semiont.Storage;
using Semiont.Types;
using Xunit;

namespace Semiont.Tests;

/// <summary>
/// What a client keeps of its queries and of its stream, against protocol/specs/src/session/cache-cases.json. Each case
/// runs through this SDK's own persistence for its query, over a storage in memory and a clock the runner holds, under
/// the keys session/stored.json gives the knowledge base <see cref="Kb"/> and the person whose key is <see cref="Person"/>.
/// </summary>
public sealed class CacheCasesTests
{
    private const string Table = "session/cache-cases.json";
    private const string Kb = "kb-1";
    private static readonly string Person = RegistryStorage.PersonKey(UserId.Parse("did:web:kb.example.org:users:jo%40example.org"));

    private static readonly IReadOnlyDictionary<string, Func<ISessionStorage, IKeptCase>> Kept = new Dictionary<string, Func<ISessionStorage, IKeptCase>>(StringComparer.Ordinal)
    {
        ["resource"] = store => new KeptCase<ResourceId, ResourceDescriptor>("resource", store, KeptKeys.ByResource<ResourceDescriptor>()),
        ["annotations"] = store => new KeptCase<ResourceId, GetAnnotationsResponse>("annotations", store, KeptKeys.ByResource<GetAnnotationsResponse>()),
        ["annotation"] = store => new KeptCase<LiveQueries.AnnotationKey, Annotation>("annotation", store, KeptKeys.ByAnnotation),
        ["entityTypes"] = store => new KeptCase<bool, IReadOnlyList<string>>("entityTypes", store, KeptKeys.Whole<IReadOnlyList<string>>()),
        ["tagSchemas"] = store => new KeptCase<bool, IReadOnlyList<TagSchema>>("tagSchemas", store, KeptKeys.Whole<IReadOnlyList<TagSchema>>()),
    };

    public static IEnumerable<object[]> Loads() => Names("cases");
    public static IEnumerable<object[]> Writes() => Names("writes");
    public static IEnumerable<object[]> Places() => Names("places");

    [Fact]
    public void ThisRunnerKeepsEveryQueryStoredJsonNames()
    {
        using var stored = JsonDocument.Parse(File.ReadAllText(Path.Join(AppContext.BaseDirectory, "specs", "session/stored.json")));
        var named = stored.RootElement.GetProperty("keptQueries").EnumerateArray().Select(row => Text(row, "query"));
        Assert.Equal(named.Order(StringComparer.Ordinal), Kept.Keys.Order(StringComparer.Ordinal));
    }

    [Theory]
    [MemberData(nameof(Loads))]
    public void ALoadKeepsWhatItsCaseSays(string name)
    {
        var row = Row("cases", name);
        var query = Text(row, "query");
        var store = new MemoryStorage();
        store.Set(RegistryStorage.CacheKey(Kb, Person, query), Stored(row));
        using var kept = Kept[query](store);
        SameEntries(row.GetProperty("kept").EnumerateArray().ToArray(), kept.Held());
    }

    [Theory]
    [MemberData(nameof(Writes))]
    public void ASaveWritesWhatItsCaseSays(string name)
    {
        var row = Row("writes", name);
        var query = Text(row, "query");
        var store = new MemoryStorage();
        using (var kept = Kept[query](store)) kept.Hold(row.GetProperty("held"));

        var written = row.GetProperty("written");
        using var document = JsonDocument.Parse(Assert.IsType<string>(store.Get(RegistryStorage.CacheKey(Kb, Person, query))));
        var saved = document.RootElement;
        Assert.Equal(Members(written), Members(saved));
        Assert.True(JsonElement.DeepEquals(written.GetProperty("version"), saved.GetProperty("version")), name + ": version");
        var entries = saved.GetProperty("entries").EnumerateArray().ToArray();
        foreach (var entry in entries)
        {
            Assert.Equal(3, entry.GetArrayLength());
            Assert.True(entry[2].TryGetInt64(out var stamp) && stamp >= 0, name + ": stamp " + entry[2].GetRawText());
        }
        SameEntries(written.GetProperty("entries").EnumerateArray().ToArray(), entries.Select(entry => (entry[0], entry[1])).ToArray());
    }

    [Theory]
    [MemberData(nameof(Places))]
    public void APlacesLoadKeepsWhatItsCaseSays(string name)
    {
        var row = Row("places", name);
        var store = new MemoryStorage();
        store.Set(RegistryStorage.LastEventIdKey(Kb, Person), Stored(row));
        using var storage = new LiveCacheStorage(new CachePersistence(store, Kb, Person), new FakeTimeProvider(), () => false);
        IReadOnlyDictionary<string, string>? restored = null;
        storage.Start([], given => restored = given);
        var places = restored ?? throw new InvalidOperationException(name + ": the persistence gave no places");
        var kept = row.GetProperty("kept").EnumerateObject().ToDictionary(place => place.Name, place => Text(row.GetProperty("kept"), place.Name));
        Assert.Equal(kept.OrderBy(place => place.Key, StringComparer.Ordinal), places.OrderBy(place => place.Key, StringComparer.Ordinal));
    }

    private static void SameEntries(JsonElement[] expected, (JsonElement Key, JsonElement Value)[] actual)
    {
        Assert.Equal(expected.Length, actual.Length);
        foreach (var entry in expected)
        {
            var found = Assert.Single(actual, held => JsonElement.DeepEquals(held.Key, entry[0]));
            Assert.True(JsonElement.DeepEquals(found.Value, entry[1]), entry[0].GetRawText() + ": " + found.Value.GetRawText());
        }
    }

    private static string[] Members(JsonElement value) => value.EnumerateObject().Select(member => member.Name).Order(StringComparer.Ordinal).ToArray();

    private static string Stored(JsonElement row) =>
        row.TryGetProperty("storedText", out var text) ? Text(row, "storedText") : row.GetProperty("stored").GetRawText();

    private static IEnumerable<object[]> Names(string section)
    {
        using var table = ReadTable();
        foreach (var row in table.RootElement.GetProperty(section).EnumerateArray()) yield return [Text(row, "name")];
    }

    private static JsonElement Row(string section, string name)
    {
        using var table = ReadTable();
        return table.RootElement.GetProperty(section).EnumerateArray().Single(row => Text(row, "name") == name).Clone();
    }

    private static JsonDocument ReadTable() =>
        JsonDocument.Parse(File.ReadAllText(Path.Join(AppContext.BaseDirectory, "specs", Table)));

    private static string Text(JsonElement row, string name) =>
        row.GetProperty(name).GetString() ?? throw new InvalidOperationException("Missing " + name);

    private interface IKeptCase : IDisposable
    {
        /// <summary>Each value the query's cache holds, under its key as the document writes it.</summary>
        public (JsonElement Key, JsonElement Value)[] Held();

        /// <summary>Gives the query's cache each entry's value under its key, as answers do.</summary>
        public void Hold(JsonElement entries);
    }

    /// <summary>One kept query's cache and the persistence that keeps it, as a session wires them; disposing it saves
    /// what it owes.</summary>
    private sealed class KeptCase<TKey, T> : IKeptCase where TKey : notnull
    {
        private readonly LiveCacheStorage storage;
        private readonly Cache<TKey, T> cache;
        private readonly KeptKey<TKey, T> key;

        internal KeptCase(string query, ISessionStorage store, KeptKey<TKey, T> key)
        {
            var clock = new FakeTimeProvider();
            this.key = key;
            storage = new LiveCacheStorage(new CachePersistence(store, Kb, Person), clock, () => false);
            cache = new Cache<TKey, T>((held, _) => throw new InvalidOperationException("A kept case fetched " + held), null, clock, TimeSpan.Zero,
                storage.Changed(query));
            storage.Start([storage.Keep(query, cache, key)], _ => { });
        }

        public (JsonElement Key, JsonElement Value)[] Held()
        {
            var held = new List<(JsonElement, JsonElement)>();
            foreach (var (id, query) in cache.Snapshot())
                if (query.CurrentValue is { } ready)
                    held.Add((JsonSerializer.SerializeToElement(key.Write(id)), JsonSerializer.SerializeToElement(ready.Value)));
            return held.ToArray();
        }

        public void Hold(JsonElement entries)
        {
            foreach (var entry in entries.EnumerateArray())
            {
                var value = entry[1].Deserialize<T>() is T read ? read : throw new InvalidOperationException("A held value is null.");
                cache.Set(key.Read(entry[0], value), value);
            }
        }

        public void Dispose()
        {
            storage.Dispose();
            cache.Dispose();
        }
    }
}
