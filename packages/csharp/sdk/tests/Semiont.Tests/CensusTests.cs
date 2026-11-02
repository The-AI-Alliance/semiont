using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Semiont.Analyzers;
using Xunit;

namespace Semiont.Tests;

public sealed class CensusTests
{
    public static IEnumerable<object[]> Refusals()
    {
        foreach (var file in Directory.GetFiles(Path.Combine(AppContext.BaseDirectory, "refusals"), "*.cs").Order())
        {
            var source = File.ReadAllText(file);
            var firstLine = source.Split('\n')[0];
            Assert.StartsWith("// expect: ", firstLine);
            yield return new object[] { source, firstLine["// expect: ".Length..].Trim() };
        }
    }

    [Theory]
    [MemberData(nameof(Refusals))]
    public async Task RefusalFixturesReportTheirExpectedDiagnostic(string source, string expected)
    {
        var tree = CSharpSyntaxTree.ParseText(source);
        var references = new[]
        {
            MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(System.Runtime.CompilerServices.DynamicAttribute).Assembly.Location),
            MetadataReference.CreateFromFile(System.Reflection.Assembly.Load("System.Runtime").Location),
        };
        var compilation = CSharpCompilation.Create("Example", [tree], references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));
        var compilerDiagnostics = compilation.GetDiagnostics();
        if (expected.StartsWith("SEM", StringComparison.Ordinal))
        {
            Assert.DoesNotContain(compilerDiagnostics, diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
        }
        var analyzerDiagnostics = await compilation.WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(new CensusAnalyzer()))
            .GetAnalyzerDiagnosticsAsync();
        Assert.Contains(compilerDiagnostics.Concat(analyzerDiagnostics), diagnostic => diagnostic.Id == expected);
        Assert.DoesNotContain(analyzerDiagnostics, diagnostic => diagnostic.Id == "AD0001");
    }

    [Fact]
    public async Task SkippedTestIsRefused()
    {
        var tree = CSharpSyntaxTree.ParseText("public sealed class Example { [Xunit.Fact(Skip = \"later\")] public void Test() {} }");
        var references = new[]
        {
            MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(FactAttribute).Assembly.Location),
            MetadataReference.CreateFromFile(System.Reflection.Assembly.Load("System.Runtime").Location),
        };
        var compilation = CSharpCompilation.Create("Example", [tree], references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        Assert.Empty(compilation.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error));
        var diagnostics = await compilation.WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(new CensusAnalyzer()))
            .GetAnalyzerDiagnosticsAsync();
        Assert.Equal("SEM006", Assert.Single(diagnostics).Id);
    }

    [Theory]
    [InlineData("public static string? Read() => System.Environment.GetEnvironmentVariable(\"SEMIONT_BUS_LOG\");")]
    [InlineData("public static async System.Threading.Tasks.Task<int> Read() => await System.Threading.Tasks.Task.FromResult(1);")]
    [InlineData("public static int Read() => new { Result = 1 }.Result;")]
    [InlineData("public static bool Read(string? value) => value is not null;")]
    public async Task ValidCodeHasNoCensusDiagnostic(string member)
    {
        var tree = CSharpSyntaxTree.ParseText("#nullable enable\npublic static class Example { " + member + " }");
        var references = new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) };
        var compilation = CSharpCompilation.Create("Example", [tree], references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        Assert.Empty(compilation.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error));
        var diagnostics = await compilation.WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(new CensusAnalyzer()))
            .GetAnalyzerDiagnosticsAsync();
        Assert.Empty(diagnostics);
    }
}
