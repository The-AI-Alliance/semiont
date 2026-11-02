using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Semiont.Analyzers;
using Xunit;

namespace Semiont.Tests;

public sealed class CensusTests
{
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
