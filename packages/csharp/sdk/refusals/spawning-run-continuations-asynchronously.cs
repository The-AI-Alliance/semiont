// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Threading.Tasks.TaskCompletionSource Completion() => new(System.Threading.Tasks.TaskCreationOptions.RunContinuationsAsynchronously);
}
