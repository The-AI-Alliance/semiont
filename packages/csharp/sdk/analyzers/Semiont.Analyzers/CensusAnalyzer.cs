using System;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

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
    private static readonly DiagnosticDescriptor ClockEscape = Rule("SEM007", "Wait, measure and draw on the TimeProvider and Random the caller gives");

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(NullForgiveness, Blocking, Dynamic, Suppression, EnvironmentRead, SkippedTest, ClockEscape);

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
        context.RegisterCompilationStartAction(CheckClock);
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

    /// <summary>
    /// Product code keeps every wait, deadline and interval on the caller's TimeProvider and every jitter on the
    /// caller's Random; TimeProvider.System and Random.Shared are only ever the default of one not given. A test
    /// keeps its own time, so a test project is not held to it.
    /// </summary>
    private static void CheckClock(CompilationStartAnalysisContext context)
    {
        if (context.Options.AnalyzerConfigOptionsProvider.GlobalOptions.TryGetValue("build_property.IsTestProject", out var test) &&
            string.Equals(test, "true", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }
        context.RegisterOperationAction(CheckClockCall, OperationKind.Invocation);
        context.RegisterOperationAction(CheckClockCreation, OperationKind.ObjectCreation);
        context.RegisterOperationAction(CheckClockProperty, OperationKind.PropertyReference);
        context.RegisterOperationAction(CheckClockField, OperationKind.FieldReference);
    }

    private static void ReportClock(OperationAnalysisContext context) =>
        context.ReportDiagnostic(Diagnostic.Create(ClockEscape, context.Operation.Syntax.GetLocation()));

    private static bool IsType(ITypeSymbol? type, string space, string name) =>
        type is INamedTypeSymbol named && named.Name == name && named.ContainingNamespace.ToDisplayString() == space;

    private static bool DerivesFrom(ITypeSymbol? type, string space, string name)
    {
        for (var current = type; current is not null; current = current.BaseType)
        {
            if (IsType(current, space, name))
            {
                return true;
            }
        }
        return false;
    }

    private static bool TakesClock(IMethodSymbol method) => method.Parameters.Any(parameter => IsType(parameter.Type, "System", "TimeProvider"));

    private static bool TakesTimeout(IMethodSymbol method) => method.Parameters.Any(parameter =>
        IsType(parameter.Type, "System", "TimeSpan") || parameter.Name.StartsWith("milliseconds", StringComparison.Ordinal));

    /// <summary>Whether <paramref name="operation"/> is what a <c>??</c> gives when its left side, of the type named, is null.</summary>
    private static bool IsDefault(IOperation operation, string space, string name)
    {
        var given = operation;
        var parent = operation.Parent;
        while (parent is IConversionOperation)
        {
            given = parent;
            parent = parent.Parent;
        }
        return parent is ICoalesceOperation coalesce && coalesce.WhenNull == given && IsType(coalesce.Value.Type, space, name);
    }

    private static bool IsInfinite(IOperation value)
    {
        while (value is IConversionOperation conversion)
        {
            value = conversion.Operand;
        }
        return value is IFieldReferenceOperation field && field.Field.Name == "InfiniteTimeSpan" &&
            IsType(field.Field.ContainingType, "System.Threading", "Timeout");
    }

    private static void CheckClockCall(OperationAnalysisContext context)
    {
        var method = ((IInvocationOperation)context.Operation).TargetMethod;
        var owner = method.ContainingType;
        if (method.Name == "Delay" && IsType(owner, "System.Threading.Tasks", "Task") && !TakesClock(method) ||
            method.Name == "WaitAsync" && TakesTimeout(method) && !TakesClock(method) ||
            method.Name == "CancelAfter" && IsType(owner, "System.Threading", "CancellationTokenSource") ||
            method.Name == "Sleep" && IsType(owner, "System.Threading", "Thread") ||
            IsType(owner, "System.Diagnostics", "Stopwatch"))
        {
            ReportClock(context);
        }
    }

    private static void CheckClockCreation(OperationAnalysisContext context)
    {
        var creation = (IObjectCreationOperation)context.Operation;
        if (creation.Constructor is not { } constructor)
        {
            return;
        }
        var made = constructor.ContainingType;
        if (IsType(made, "System.Threading", "CancellationTokenSource") && constructor.Parameters.Length > 0 && !TakesClock(constructor) ||
            IsType(made, "System.Threading", "PeriodicTimer") && !TakesClock(constructor) ||
            IsType(made, "System.Threading", "Timer") || IsType(made, "System.Timers", "Timer") ||
            IsType(made, "System.Diagnostics", "Stopwatch") ||
            DerivesFrom(made, "System", "Random") && !IsDefault(creation, "System", "Random") ||
            DerivesFrom(made, "System.Net.Http", "HttpClient") && !KeepsNoTimeout(creation))
        {
            ReportClock(context);
        }
    }

    /// <summary>Whether a new HttpClient's initializer sets its Timeout to Timeout.InfiniteTimeSpan: the SDK keeps its own deadlines.</summary>
    private static bool KeepsNoTimeout(IObjectCreationOperation creation) =>
        creation.Initializer is { } initializer && initializer.Initializers.OfType<ISimpleAssignmentOperation>().Any(assignment =>
            assignment.Target is IPropertyReferenceOperation { Property.Name: "Timeout" } && IsInfinite(assignment.Value));

    private static void CheckClockProperty(OperationAnalysisContext context)
    {
        var reference = (IPropertyReferenceOperation)context.Operation;
        var property = reference.Property;
        var owner = property.ContainingType;
        if (IsType(owner, "System", "DateTime") && property.Name is "Now" or "UtcNow" or "Today" ||
            IsType(owner, "System", "DateTimeOffset") && property.Name is "Now" or "UtcNow" ||
            IsType(owner, "System", "Environment") && property.Name is "TickCount" or "TickCount64" ||
            IsType(owner, "System.Diagnostics", "Stopwatch") ||
            IsType(owner, "System", "Random") && property.Name == "Shared" && !IsDefault(reference, "System", "Random") ||
            IsType(owner, "System", "TimeProvider") && property.Name == "System" && !IsDefault(reference, "System", "TimeProvider") ||
            IsType(owner, "System.Net.Http", "HttpClient") && property.Name == "Timeout" &&
            reference.Parent is ISimpleAssignmentOperation assignment && assignment.Target == reference && !IsInfinite(assignment.Value))
        {
            ReportClock(context);
        }
    }

    private static void CheckClockField(OperationAnalysisContext context)
    {
        if (IsType(((IFieldReferenceOperation)context.Operation).Field.ContainingType, "System.Diagnostics", "Stopwatch"))
        {
            ReportClock(context);
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
