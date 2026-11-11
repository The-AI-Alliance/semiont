using System.Reflection;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Semiont.Generator;
using Xunit;

namespace Semiont.Tests;

public sealed class GenerationTests
{
    [Fact]
    public void EveryIdentifierKindRunsItsSharedCases()
    {
        var assembly = Assembly.Load("Semiont");
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "specs/identifiers/kinds.json")));
        foreach (var kind in document.RootElement.GetProperty("kinds").EnumerateArray())
        {
            var name = kind.GetProperty("schema").GetString() ?? throw new InvalidOperationException("An identifier kind has no name.");
            var type = assembly.GetType("Semiont.Identifiers." + name);
            Assert.NotNull(type);
            var parse = type.GetMethod("Parse", [typeof(string)]);
            Assert.NotNull(parse);
            foreach (var accepted in kind.GetProperty("accepts").EnumerateArray())
            {
                var text = accepted.GetProperty("id").GetString();
                var value = parse.Invoke(null, [text]);
                Assert.Equal(text, value?.ToString());
                Assert.Equal(JsonSerializer.Serialize(text), JsonSerializer.Serialize(value, type));
                Assert.Equal(value, JsonSerializer.Deserialize(JsonSerializer.Serialize(text), type));
            }
            foreach (var refused in kind.GetProperty("refuses").EnumerateArray())
            {
                var text = refused.GetProperty("id").GetString();
                var error = Assert.Throws<TargetInvocationException>(() => parse.Invoke(null, [text]));
                Assert.IsType<FormatException>(error.InnerException);
                Assert.Throws<JsonException>(() => JsonSerializer.Deserialize(JsonSerializer.Serialize(text), type));
            }
        }
    }

    [Fact]
    public void AGeneratedCommandRoundTripsAndKeepsTypedIds()
    {
        var type = Assembly.Load("Semiont").GetType("Semiont.Types.MarkDeleteCommand");
        Assert.NotNull(type);
        Assert.Equal("Semiont.Identifiers.ResourceId", Nullable.GetUnderlyingType(type.GetProperty("ResourceId")?.PropertyType ?? throw new InvalidOperationException())?.FullName);
        const string source = "{\"annotationId\":\"a-1\",\"resourceId\":\"res-1\"}";
        var value = JsonSerializer.Deserialize(source, type);
        Assert.True(System.Text.Json.Nodes.JsonNode.DeepEquals(
            System.Text.Json.Nodes.JsonNode.Parse(source), JsonSerializer.SerializeToNode(value, type)));
        var error = Assert.Throws<JsonException>(() => JsonSerializer.Deserialize("{\"resourceId\":\"res-1\"}", type));
        Assert.Contains("annotationId", error.Message);
    }

    [Theory]
    [InlineData("{\"annotations\":[],\"total\":0}")]
    [InlineData("{\"annotations\":[],\"total\":0,\"motivation\":null}")]
    [InlineData("{\"annotations\":[],\"total\":0,\"motivation\":\"highlighting\"}")]
    public void AnOptionalNullableMemberKeepsAllThreeStates(string source)
    {
        var type = Assembly.Load("Semiont").GetType("Semiont.Types.GetAnnotationsResponse");
        Assert.NotNull(type);
        var value = JsonSerializer.Deserialize(source, type);
        Assert.True(System.Text.Json.Nodes.JsonNode.DeepEquals(
            System.Text.Json.Nodes.JsonNode.Parse(source), JsonSerializer.SerializeToNode(value, type)));
    }

    [Theory]
    [InlineData("{\"type\":\"object\",\"patternProperties\":{\"x\":{\"type\":\"string\"}}}")]
    [InlineData("{\"type\":\"string\",\"format\":\"uuid\"}")]
    [InlineData("{\"type\":\"null\"}")]
    [InlineData("{\"type\":\"array\",\"items\":{\"type\":\"string\",\"not\":{}}}")]
    [InlineData("{\"type\":\"object\",\"additionalProperties\":3}")]
    [InlineData("{\"$ref\":\"./Absent.json\"}")]
    [InlineData("{")]
    public void AnUnsupportedSchemaFailsGeneration(string schema)
    {
        var tree = CSharpSyntaxTree.ParseText("public sealed class Example {} ");
        var compilation = CSharpCompilation.Create("Example", [tree],
            [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)],
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        GeneratorDriver driver = CSharpGeneratorDriver.Create(
            generators: [new ProtocolGenerator().AsSourceGenerator()],
            additionalTexts: [new SpecFile("/specs/src/components/schemas/Unsupported.json", schema), RequiredTable(), UnicodeCaseTable()]);
        driver = driver.RunGenerators(compilation);
        Assert.Contains(driver.GetRunResult().Diagnostics, diagnostic => diagnostic.Id == "SEMGEN001");
    }

    [Fact]
    public void EverySchemaGeneratesInProcessWithoutDiagnostics()
    {
        var result = Generated([.. SpecFiles(), RequiredTable(), UnicodeCaseTable()]);
        Assert.Empty(result.Diagnostics);
        Assert.True(result.GeneratedTrees.Length > 300);
        Assert.All(result.GeneratedTrees, tree => Assert.DoesNotContain(tree.GetDiagnostics(), diagnostic => diagnostic.Severity == DiagnosticSeverity.Error));
    }

    [Fact]
    public void GenerationWithoutTheTableOfWhatEachSchemaRequiresFails()
    {
        var result = Generated([.. SpecFiles(), UnicodeCaseTable()]);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "SEMGEN001"
            && diagnostic.GetMessage(System.Globalization.CultureInfo.InvariantCulture).Contains("required-schemas.json", StringComparison.Ordinal));
        Assert.Empty(result.GeneratedTrees);
    }

    [Fact]
    public void GenerationWithoutUnicodesCasePropertiesFails()
    {
        var result = Generated([.. SpecFiles(), RequiredTable()]);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "SEMGEN001"
            && diagnostic.GetMessage(System.Globalization.CultureInfo.InvariantCulture).Contains("unicode-case.json", StringComparison.Ordinal));
        Assert.Empty(result.GeneratedTrees);
    }

    [Fact]
    public void GenerationFailsForACodeOfCommandErrorThatCodesJsonMapsToNoFailure()
    {
        var files = SpecFiles().Select(file => file.Path.EndsWith("/errors/codes.json", StringComparison.Ordinal)
            ? new SpecFile(file.Path, WithoutWire(file.GetText().ToString(), "none-pending")) : file);
        var result = Generated([.. files, RequiredTable(), UnicodeCaseTable()]);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "SEMGEN001"
            && diagnostic.GetMessage(System.Globalization.CultureInfo.InvariantCulture).Contains("code none-pending to no bus request's failure", StringComparison.Ordinal));
    }

    /// <summary><paramref name="errors"/>, errors/codes.json, with no bus request's failure mapped from <paramref name="wire"/>.</summary>
    private static string WithoutWire(string errors, string wire)
    {
        var table = System.Text.Json.Nodes.JsonNode.Parse(errors) ?? throw new InvalidOperationException("errors/codes.json is null.");
        var codes = table["busRequest"]?["codes"]?.AsArray() ?? throw new InvalidOperationException("errors/codes.json has no bus request's codes.");
        var mapped = codes.Select(code => code?.AsObject()).Single(code => code?["wire"]?.GetValue<string>() == wire)
            ?? throw new InvalidOperationException("errors/codes.json maps nothing from " + wire + ".");
        mapped.Remove("wire");
        return table.ToJsonString();
    }

    private static SpecFile[] SpecFiles() =>
        Directory.GetFiles(Path.Combine(AppContext.BaseDirectory, "specs"), "*", SearchOption.AllDirectories).Where(path => path.EndsWith(".json", StringComparison.Ordinal) || path.EndsWith("README.md", StringComparison.Ordinal))
            .Select(path => new SpecFile("/specs/src/" + Path.GetRelativePath(Path.Combine(AppContext.BaseDirectory, "specs"), path).Replace('\\', '/'), File.ReadAllText(path))).ToArray();

    // The table of what each component schema requires, at the path the SDK's project gives the generator.
    private static SpecFile RequiredTable() => new("/generators/Semiont.Generator/required-schemas.json",
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "generators/required-schemas.json")));

    // Unicode's Cased and Case_Ignorable properties, at the path the SDK's project gives the generator.
    private static SpecFile UnicodeCaseTable() => new("/generators/Semiont.Generator/unicode-case.json",
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "generators/unicode-case.json")));

    private static GeneratorDriverRunResult Generated(SpecFile[] files)
    {
        var compilation = CSharpCompilation.Create("Example", options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        GeneratorDriver driver = CSharpGeneratorDriver.Create(generators: [new ProtocolGenerator().AsSourceGenerator()], additionalTexts: files);
        return driver.RunGenerators(compilation).GetRunResult();
    }

    [Fact]
    public void EveryRootSchemaHasItsExpectedPublicType()
    {
        var assembly = Assembly.Load("Semiont");
        foreach (var path in Directory.GetFiles(Path.Combine(AppContext.BaseDirectory, "specs/components/schemas"), "*.json"))
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var schema = document.RootElement;
            var name = Path.GetFileNameWithoutExtension(path);
            var plainString = schema.TryGetProperty("type", out var type) && type.GetString() == "string" && !schema.TryGetProperty("enum", out _);
            var identifier = assembly.GetType("Semiont.Identifiers." + name);
            if (!plainString || identifier is not null)
            {
                Assert.NotNull(identifier ?? assembly.GetType("Semiont.Types." + name));
            }
        }
    }

    private sealed class SpecFile(string path, string contents) : AdditionalText
    {
        public override string Path { get; } = path;

        public override SourceText GetText(CancellationToken cancellationToken = default) => SourceText.From(contents);
    }
}
