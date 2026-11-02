using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Semiont.Analyzers;
using Xunit;

namespace Semiont.Tests;

public sealed class CensusTests
{
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
