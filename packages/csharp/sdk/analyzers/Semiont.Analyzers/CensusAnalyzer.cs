using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Semiont.Analyzers;

[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class CensusAnalyzer : DiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor NullForgiveness = Rule("SEM001", "Null forgiveness hides an unchecked value");
    private static readonly DiagnosticDescriptor Blocking = Rule("SEM002", "Await a task instead of blocking on it");
    private static readonly DiagnosticDescriptor Dynamic = Rule("SEM003", "Use a static type instead of dynamic");
    private static readonly DiagnosticDescriptor Suppression = Rule("SEM004", "Fix a diagnostic instead of suppressing it");
    private static readonly DiagnosticDescriptor EnvironmentRead = Rule("SEM005", "Only SEMIONT_BUS_LOG may be read from the environment");
    private static readonly DiagnosticDescriptor SkippedTest = Rule("SEM006", "Tests must run instead of being skipped");

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(NullForgiveness, Blocking, Dynamic, Suppression, EnvironmentRead, SkippedTest);

    public override void Initialize(AnalysisContext context)
    {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.Analyze | GeneratedCodeAnalysisFlags.ReportDiagnostics);
        context.EnableConcurrentExecution();
        context.RegisterSyntaxNodeAction(c => Report(c, NullForgiveness), SyntaxKind.SuppressNullableWarningExpression);
        context.RegisterSyntaxNodeAction(CheckIdentifier, SyntaxKind.IdentifierName);
        context.RegisterSyntaxNodeAction(CheckMember, SyntaxKind.SimpleMemberAccessExpression);
        context.RegisterSyntaxNodeAction(CheckInvocation, SyntaxKind.InvocationExpression);
        context.RegisterSyntaxNodeAction(CheckAttribute, SyntaxKind.Attribute);
        context.RegisterSyntaxTreeAction(CheckDirectives);
    }

    private static DiagnosticDescriptor Rule(string id, string message) =>
        new DiagnosticDescriptor(id, message, message, "Semiont", DiagnosticSeverity.Error, isEnabledByDefault: true);

    private static void Report(SyntaxNodeAnalysisContext context, DiagnosticDescriptor rule) =>
        context.ReportDiagnostic(Diagnostic.Create(rule, context.Node.GetLocation()));

    private static bool IsTask(ITypeSymbol? type) => type is INamedTypeSymbol named &&
        named.ContainingNamespace.ToDisplayString() == "System.Threading.Tasks" &&
        (named.Name == "Task" || named.Name == "ValueTask");

    private static void CheckIdentifier(SyntaxNodeAnalysisContext context)
    {
        if (context.SemanticModel.GetTypeInfo(context.Node, context.CancellationToken).Type?.TypeKind == TypeKind.Dynamic)
        {
            Report(context, Dynamic);
        }
    }

    private static void CheckMember(SyntaxNodeAnalysisContext context)
    {
        var member = (MemberAccessExpressionSyntax)context.Node;
        if (context.SemanticModel.GetSymbolInfo(member, context.CancellationToken).Symbol is IPropertySymbol property &&
            property.Name == "Result" && IsTask(property.ContainingType))
        {
            Report(context, Blocking);
        }
    }

    private static void CheckInvocation(SyntaxNodeAnalysisContext context)
    {
        var call = (InvocationExpressionSyntax)context.Node;
        if (context.SemanticModel.GetSymbolInfo(call, context.CancellationToken).Symbol is not IMethodSymbol method)
        {
            return;
        }
        if ((method.Name == "Wait" || method.Name == "WaitAll" || method.Name == "WaitAny") && IsTask(method.ContainingType) ||
            method.Name == "GetResult" && method.ContainingNamespace.ToDisplayString() == "System.Runtime.CompilerServices" &&
            (method.ContainingType.Name == "TaskAwaiter" || method.ContainingType.Name == "ValueTaskAwaiter" ||
             method.ContainingType.Name == "ConfiguredTaskAwaitable" || method.ContainingType.Name == "ConfiguredValueTaskAwaitable" ||
             method.ContainingType.ContainingType?.Name == "ConfiguredTaskAwaitable" ||
             method.ContainingType.ContainingType?.Name == "ConfiguredValueTaskAwaitable"))
        {
            Report(context, Blocking);
        }
        if (method.ContainingType.ToDisplayString() == "System.Environment" &&
            (method.Name == "GetEnvironmentVariable" || method.Name == "GetEnvironmentVariables" || method.Name == "ExpandEnvironmentVariables"))
        {
            var allowed = method.Name == "GetEnvironmentVariable" && call.ArgumentList.Arguments.Count == 1 &&
                context.SemanticModel.GetConstantValue(call.ArgumentList.Arguments[0].Expression, context.CancellationToken) is { HasValue: true, Value: "SEMIONT_BUS_LOG" };
            if (!allowed)
            {
                Report(context, EnvironmentRead);
            }
        }
    }

    private static void CheckAttribute(SyntaxNodeAnalysisContext context)
    {
        var attribute = (AttributeSyntax)context.Node;
        if (context.SemanticModel.GetSymbolInfo(attribute, context.CancellationToken).Symbol is not IMethodSymbol constructor)
        {
            return;
        }
        if (constructor.ContainingType.ToDisplayString() == "System.Diagnostics.CodeAnalysis.SuppressMessageAttribute" ||
            constructor.ContainingType.ToDisplayString() == "System.Diagnostics.CodeAnalysis.UnconditionalSuppressMessageAttribute")
        {
            Report(context, Suppression);
        }
        if (constructor.ContainingNamespace.ToDisplayString() == "Xunit" &&
            attribute.ArgumentList is { } arguments)
        {
            foreach (var argument in arguments.Arguments)
            {
                if (argument.NameEquals?.Name.Identifier.ValueText is "Skip" or "SkipWhen" or "SkipUnless" or "Explicit")
                {
                    Report(context, SkippedTest);
                }
            }
        }
    }

    private static void CheckDirectives(SyntaxTreeAnalysisContext context)
    {
        foreach (var trivia in context.Tree.GetRoot(context.CancellationToken).DescendantTrivia(descendIntoTrivia: true))
        {
            if (trivia.IsKind(SyntaxKind.PragmaWarningDirectiveTrivia))
            {
                context.ReportDiagnostic(Diagnostic.Create(Suppression, trivia.GetLocation()));
            }
        }
    }
}
