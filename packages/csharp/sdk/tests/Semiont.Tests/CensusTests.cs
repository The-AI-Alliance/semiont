using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Semiont.Analyzers;
using Xunit;

namespace Semiont.Tests;

public sealed class CensusTests
{
    /// <summary>Every assembly of the shared framework this test runs on: what a fixture may name, as the SDK may.</summary>
    private static readonly MetadataReference[] Framework = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            ?? throw new InvalidOperationException("The runtime names no trusted platform assemblies"))
        .Split(Path.PathSeparator)
        .Where(path => Path.GetDirectoryName(path) == Path.GetDirectoryName(typeof(object).Assembly.Location))
        .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
        .ToArray();

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
        var compilation = CSharpCompilation.Create("Example", [tree], Framework,
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
    [InlineData("public static System.Threading.Tasks.Task Wait(System.TimeProvider clock) => System.Threading.Tasks.Task.Delay(System.TimeSpan.FromSeconds(1), clock);")]
    [InlineData("public static System.Threading.Tasks.Task Wait(System.Threading.Tasks.Task work, System.TimeProvider clock) => work.WaitAsync(System.TimeSpan.FromSeconds(1), clock);")]
    [InlineData("public static System.Threading.Tasks.Task Turn(System.Threading.SemaphoreSlim turn, System.Threading.CancellationToken cancellation) => turn.WaitAsync(cancellation);")]
    [InlineData("public static System.Threading.CancellationTokenSource Deadline(System.TimeProvider clock) => new(System.TimeSpan.FromSeconds(1), clock);")]
    [InlineData("public static System.Threading.CancellationTokenSource Lifetime() => new();")]
    [InlineData("public static System.Threading.PeriodicTimer Ticks(System.TimeProvider clock) => new(System.TimeSpan.FromSeconds(1), clock);")]
    [InlineData("public static System.DateTimeOffset Now(System.TimeProvider clock) => clock.GetUtcNow();")]
    [InlineData("public static System.TimeProvider Clock(System.TimeProvider? given) => given ?? System.TimeProvider.System;")]
    [InlineData("public static System.Random Draws(System.Random? given) => given ?? System.Random.Shared;")]
    [InlineData("public static System.Net.Http.HttpClient Client() => new() { Timeout = System.Threading.Timeout.InfiniteTimeSpan };")]
    [InlineData("public static System.TimeSpan Limit(System.Net.Http.HttpClient client) => client.Timeout;")]
    [InlineData("public static System.Guid Id() => System.Guid.NewGuid();")]
    [InlineData("public static byte[] Secret() => System.Security.Cryptography.RandomNumberGenerator.GetBytes(16);")]
    public async Task ValidCodeHasNoCensusDiagnostic(string member)
    {
        var tree = CSharpSyntaxTree.ParseText("#nullable enable\npublic static class Example { " + member + " }");
        var compilation = CSharpCompilation.Create("Example", [tree], Framework,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        Assert.Empty(compilation.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error));
        var diagnostics = await compilation.WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(new CensusAnalyzer()))
            .GetAnalyzerDiagnosticsAsync();
        Assert.Empty(diagnostics);
    }
}
