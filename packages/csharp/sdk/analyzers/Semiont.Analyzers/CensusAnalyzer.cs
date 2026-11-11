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
    private static readonly DiagnosticDescriptor SpawningEscape = Rule("SEM008", "Start, resume and wait on work through Spawning");

    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics =>
        ImmutableArray.Create(NullForgiveness, Blocking, Dynamic, Suppression, EnvironmentRead, SkippedTest, ClockEscape, SpawningEscape);

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
        context.RegisterCompilationStartAction(CheckSpawning);
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

    /// <summary>
    /// A compilation that declares Semiont.Spawning, the SDK's, starts, resumes and waits on its work only through it,
    /// so a test that plays a case on a context of its own keeps all of the case's work there: every await is configured
    /// by Spawning.Captures or Spawning.Options, and none of the forms that would send work to the thread pool is called
    /// outside Spawning. A compilation without it, a test's or a tool's, is not held to it.
    /// </summary>
    private static void CheckSpawning(CompilationStartAnalysisContext context)
    {
        if (context.Compilation.GetTypeByMetadataName("Semiont.Spawning") is not { } spawning ||
            !SymbolEqualityComparer.Default.Equals(spawning.ContainingAssembly, context.Compilation.Assembly))
        {
            return;
        }
        context.RegisterOperationAction(c => CheckSpawningCall(c, spawning), OperationKind.Invocation);
        context.RegisterOperationAction(c => CheckSpawningAwait(c, spawning), OperationKind.Await);
        context.RegisterOperationAction(c => CheckSpawningLoop(c, spawning), OperationKind.Loop);
        context.RegisterOperationAction(c => CheckSpawningUsing(c, spawning), OperationKind.Using, OperationKind.UsingDeclaration);
        context.RegisterOperationAction(c => CheckSpawningCreation(c, spawning), OperationKind.ObjectCreation);
        context.RegisterOperationAction(c => CheckSpawningField(c, spawning), OperationKind.FieldReference);
    }

    private static void ReportSpawning(OperationAnalysisContext context, INamedTypeSymbol spawning)
    {
        for (ISymbol? within = context.ContainingSymbol; within is not null; within = within.ContainingSymbol)
        {
            if (SymbolEqualityComparer.Default.Equals(within, spawning))
            {
                return;
            }
        }
        context.ReportDiagnostic(Diagnostic.Create(SpawningEscape, context.Operation.Syntax.GetLocation()));
    }

    private static bool IsSpawning(ISymbol member, INamedTypeSymbol spawning, string name) =>
        member.Name == name && SymbolEqualityComparer.Default.Equals(member.ContainingType, spawning);

    private static IOperation Unconverted(IOperation operation)
    {
        while (operation is IConversionOperation conversion)
        {
            operation = conversion.Operand;
        }
        return operation;
    }

    /// <summary>Whether <paramref name="operation"/> is a ConfigureAwait call: what an await, an await foreach and an
    /// await using are each given, its setting held to the seam's by <see cref="CheckSpawningCall"/>.</summary>
    private static bool IsConfigured(IOperation operation) =>
        Unconverted(operation) is IInvocationOperation { TargetMethod.Name: "ConfigureAwait" };

    private static void CheckSpawningCall(OperationAnalysisContext context, INamedTypeSymbol spawning)
    {
        var call = (IInvocationOperation)context.Operation;
        var method = call.TargetMethod;
        var owner = method.ContainingType;
        if (method.Name == "ConfigureAwait")
        {
            var setting = Unconverted(call.Arguments[call.Arguments.Length - 1].Value);
            if (!(setting is IPropertyReferenceOperation captures && IsSpawning(captures.Property, spawning, "Captures") ||
                  setting is IInvocationOperation options && IsSpawning(options.TargetMethod, spawning, "Options")))
            {
                ReportSpawning(context, spawning);
            }
            return;
        }
        if (IsType(owner, "System.Threading.Tasks", "Task") && method.Name is "Run" or "WhenAny" or "WhenAll" or "WaitAsync" or "ContinueWith" ||
            IsType(owner, "System.Threading.Tasks", "TaskFactory") && method.Name == "StartNew" ||
            IsType(owner, "System.Threading", "ThreadPool") ||
            IsType(owner, "System.Threading.Tasks", "Parallel") ||
            IsType(owner, "System.Threading", "CancellationTokenSource") && method.Name == "CancelAsync" ||
            IsType(owner, "System.Threading.Channels", "ChannelReader") && method.Name == "ReadAllAsync" ||
            IsType(owner, "System.Threading.Tasks", "ValueTask") && method.Name == "AsTask" ||
            // A semaphore's WaitAsync() hands back the waiter itself, which the release completes. With a token or a
            // timeout, the BCL waits for the release through the thread pool.
            IsType(owner, "System.Threading", "SemaphoreSlim") && method.Name == "WaitAsync" && method.Parameters.Length > 0)
        {
            ReportSpawning(context, spawning);
        }
    }

    private static void CheckSpawningAwait(OperationAnalysisContext context, INamedTypeSymbol spawning)
    {
        if (IsTask(Unconverted(((IAwaitOperation)context.Operation).Operation).Type))
        {
            ReportSpawning(context, spawning);
        }
    }

    private static void CheckSpawningLoop(OperationAnalysisContext context, INamedTypeSymbol spawning)
    {
        if (context.Operation is IForEachLoopOperation { IsAsynchronous: true } loop && !IsConfigured(loop.Collection))
        {
            ReportSpawning(context, spawning);
        }
    }

    private static void CheckSpawningUsing(OperationAnalysisContext context, INamedTypeSymbol spawning)
    {
        var configured = context.Operation switch
        {
            IUsingOperation { IsAsynchronous: true } block => block.Resources is IVariableDeclarationGroupOperation group ? AllConfigured(group) : IsConfigured(block.Resources),
            IUsingDeclarationOperation { IsAsynchronous: true } declaration => AllConfigured(declaration.DeclarationGroup),
            _ => true,
        };
        if (!configured)
        {
            ReportSpawning(context, spawning);
        }
    }

    private static bool AllConfigured(IVariableDeclarationGroupOperation group) =>
        group.Declarations.SelectMany(declaration => declaration.Declarators)
            .All(declarator => declarator.Initializer is { } initializer && IsConfigured(initializer.Value));

    private static void CheckSpawningCreation(OperationAnalysisContext context, INamedTypeSymbol spawning)
    {
        if (IsType(((IObjectCreationOperation)context.Operation).Type, "System.Threading", "Thread"))
        {
            ReportSpawning(context, spawning);
        }
    }

    private static void CheckSpawningField(OperationAnalysisContext context, INamedTypeSymbol spawning)
    {
        var field = ((IFieldReferenceOperation)context.Operation).Field;
        if (field.Name == "RunContinuationsAsynchronously" && IsType(field.ContainingType, "System.Threading.Tasks", "TaskCreationOptions"))
        {
            ReportSpawning(context, spawning);
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
