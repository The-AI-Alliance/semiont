using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace Semiont.Generator;

[Generator]
public sealed class ProtocolGenerator : IIncrementalGenerator
{
    private static readonly DiagnosticDescriptor Unsupported = new DiagnosticDescriptor(
        "SEMGEN001", "Unsupported protocol schema", "{0}", "Semiont", DiagnosticSeverity.Error, isEnabledByDefault: true);

    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        var files = context.AdditionalTextsProvider
            .Where(file => file.Path.EndsWith(".json", StringComparison.Ordinal) || file.Path.EndsWith(".md", StringComparison.Ordinal))
            .Select((file, cancellation) => new Input(file.Path.Replace('\\', '/'),
                file.GetText(cancellation)?.ToString() ?? throw new InvalidOperationException("Cannot read " + file.Path)))
            .Collect();
        context.RegisterSourceOutput(files, Generate);
    }

    private static void Generate(SourceProductionContext context, ImmutableArray<Input> inputs)
    {
        try
        {
            var files = new Dictionary<string, string>(StringComparer.Ordinal);
            string? requiredSchemas = null;
            string? unicodeCase = null;
            foreach (var input in inputs)
            {
                if (input.Path.EndsWith("/required-schemas.json", StringComparison.Ordinal))
                {
                    requiredSchemas = input.Contents;
                    continue;
                }
                if (input.Path.EndsWith("/unicode-case.json", StringComparison.Ordinal))
                {
                    unicodeCase = input.Contents;
                    continue;
                }
                const string marker = "/specs/src/";
                var at = input.Path.LastIndexOf(marker, StringComparison.Ordinal);
                if (at >= 0)
                {
                    files.Add(input.Path.Substring(at + marker.Length), input.Contents);
                }
            }
            if (requiredSchemas is null)
            {
                throw new InvalidOperationException("No required-schemas.json is supplied: the table of what each component schema requires, which packages/codegen/schemas/generate-required.mjs writes.");
            }
            if (unicodeCase is null)
            {
                throw new InvalidOperationException("No unicode-case.json is supplied: the code points Unicode gives the Cased and the Case_Ignorable property, which packages/codegen/schemas/generate-unicode-case.mjs writes.");
            }
            var definitions = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            var identifiers = new HashSet<string>(StringComparer.Ordinal);
            foreach (var file in files.Where(file => file.Key.StartsWith("components/schemas/", StringComparison.Ordinal)))
            {
                using var document = JsonDocument.Parse(file.Value);
                Schema.Validate(document.RootElement, file.Key);
                definitions.Add(System.IO.Path.GetFileNameWithoutExtension(file.Key), document.RootElement.Clone());
            }
            foreach (var extra in new[] { ("SignIn", "sign-in-store/SignIn.json"), ("DiscoveryDocument", "discovery/DiscoveryDocument.json"), ("DiscoveredKB", "discovery/DiscoveredKB.json") })
            {
                if (files.TryGetValue(extra.Item2, out var source))
                {
                    using var document = JsonDocument.Parse(source);
                    Schema.Validate(document.RootElement, extra.Item2);
                    definitions.Add(extra.Item1, document.RootElement.Clone());
                }
            }
            if (files.TryGetValue("session/stored.json", out var stored))
            {
                using var document = JsonDocument.Parse(stored);
                var schema = document.RootElement.GetProperty("storedSession");
                Schema.Validate(schema, "session/stored.json");
                definitions.Add("StoredSession", schema.Clone());
            }
            if (files.TryGetValue("session/cases.json", out var sessionCases))
            {
                using var document = JsonDocument.Parse(sessionCases);
                var schema = document.RootElement.GetProperty("told");
                Schema.Validate(schema, "session/cases.json");
                definitions.Add("SessionEndReason", schema.Clone());
            }
            if (files.TryGetValue("identifiers/kinds.json", out var kinds))
            {
                using var document = JsonDocument.Parse(kinds);
                foreach (var kind in document.RootElement.GetProperty("kinds").EnumerateArray())
                {
                    var name = kind.GetProperty("schema").GetString() ?? throw new InvalidOperationException("An identifier kind has no schema.");
                    if (!files.TryGetValue("components/schemas/" + name + ".json", out var source))
                    {
                        throw new InvalidOperationException("Identifier " + name + " has no schema.");
                    }
                    using var schema = JsonDocument.Parse(source);
                    var pattern = schema.RootElement.GetProperty("pattern").GetString() ?? throw new InvalidOperationException(name + " has no pattern.");
                    identifiers.Add(name);
                    context.AddSource(name + ".g.cs", SourceText.From(Identifiers.Emit(name, pattern), Encoding.UTF8));
                }
            }
            var facts = new StringBuilder("// <auto-generated/>\nnamespace Semiont.Protocol;\ninternal static class ProtocolTables {\n");
            foreach (var table in new[] { ("Registry", "bus/registry.json"), ("Timing", "client/timing.json"), ("Errors", "errors/codes.json"), ("Retry", "retry/cases.json"), ("Telemetry", "sdk-telemetry/telemetry.json"), ("Log", "bus/log-cases.json"), ("OwnerOnly", "sign-in-store/owner-only.json"), ("OAuth", "session/oauth.json"), ("ClientAssertion", "session/client-assertion-cases.json"), ("Principals", "principals/cases.json"), ("MediaTypes", "media-types/registry.json"), ("Encodings", "text/encoding-cases.json"), ("CacheRefresh", "client/refresh.json"), ("Stored", "session/stored.json"), ("Discovery", "discovery/DiscoveryDocument.json") })
            {
                if (files.TryGetValue(table.Item2, out var source))
                {
                    facts.Append("internal const string ").Append(table.Item1).Append(" = ").Append(JsonSerializer.Serialize(source)).Append(";\n");
                }
            }
            if (files.ContainsKey("sign-in-store/owner-only.json"))
            {
                if (!files.TryGetValue("sign-in-store/README.md", out var contract)) throw new InvalidOperationException("Missing sign-in store contract.");
                foreach (var fact in new[] { ("WindowsOffsetHigh", @"OffsetHigh:\s*(0x[0-9A-Fa-f]+)"), ("StoreFileName", @"<stateDir>/([a-z-]+\.json)"), ("StoreLockName", @"<stateDir>/([a-z-]+\.lock)") })
                {
                    var match = Regex.Match(contract, fact.Item2);
                    if (!match.Success) throw new InvalidOperationException("The sign-in store contract does not state " + fact.Item1);
                    facts.Append("internal const ").Append(fact.Item1 == "WindowsOffsetHigh" ? "uint " : "string ").Append(fact.Item1).Append(" = ");
                    facts.Append(fact.Item1 == "WindowsOffsetHigh" ? match.Groups[1].Value + "U" : JsonSerializer.Serialize(match.Groups[1].Value)).Append(";\n");
                }
            }
            facts.Append("}\n");
            context.AddSource("ProtocolTables.g.cs", SourceText.From(facts.ToString(), Encoding.UTF8));
            context.AddSource("UnicodeCase.g.cs", SourceText.From(UnicodeCase.Emit(unicodeCase), Encoding.UTF8));
            var busPayloads = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            if (files.TryGetValue("bus/registry.json", out var registry))
                context.AddSource("BusDescriptors.g.cs", SourceText.From(BusDescriptors.Emit(registry, definitions, busPayloads), Encoding.UTF8));
            var models = new Models(definitions, identifiers);
            foreach (var model in models.Emit())
            {
                context.AddSource(model.Key + ".g.cs", SourceText.From(model.Value, Encoding.UTF8));
            }
            if (files.TryGetValue("errors/codes.json", out var errors) && definitions.TryGetValue("CommandError", out var commandError))
                context.AddSource("FailureCodes.g.cs", SourceText.From(FailureCodes.Emit(errors, commandError, models.MemberType("CommandError", "code")), Encoding.UTF8));
            var schemas = JsonSerializer.Serialize(models.Schemas);
            context.AddSource("WireSchemas.g.cs", SourceText.From("// <auto-generated/>\nnamespace Semiont.Serialization;\ninternal static partial class WireJson { private const string SchemaSource = " + JsonSerializer.Serialize(schemas) + "; }", Encoding.UTF8));
            context.AddSource("RequiredSchemas.g.cs", SourceText.From("// <auto-generated/>\nnamespace Semiont.Serialization;\ninternal static partial class Required { private const string Table = " + JsonSerializer.Serialize(WithBusPayloads(requiredSchemas, busPayloads)) + "; }", Encoding.UTF8));
        }
        catch (Exception error) when (error is InvalidOperationException || error is JsonException || error is ArgumentException)
        {
            context.ReportDiagnostic(Diagnostic.Create(Unsupported, Location.None, error.Message));
        }
    }

    /// <summary>The table of what each component schema requires, and what each payload type the bus registry makes
    /// requires beside them.</summary>
    private static string WithBusPayloads(string table, Dictionary<string, JsonElement> busPayloads)
    {
        var read = JsonNode.Parse(table)?.AsObject() ?? throw new InvalidOperationException("The table of what each schema requires is null.");
        var schemas = read["schemas"]?.AsObject() ?? throw new InvalidOperationException("The table of what each schema requires holds no schemas.");
        foreach (var payload in busPayloads)
        {
            if (schemas.ContainsKey(payload.Key))
                throw new InvalidOperationException(payload.Key + " is both a component schema and a payload type the bus registry makes.");
            schemas.Add(payload.Key, JsonNode.Parse(payload.Value.GetRawText()));
        }
        return read.ToJsonString();
    }

    private sealed class Input
    {
        internal Input(string path, string contents)
        {
            Path = path;
            Contents = contents;
        }

        internal string Path { get; }

        internal string Contents { get; }
    }
}
