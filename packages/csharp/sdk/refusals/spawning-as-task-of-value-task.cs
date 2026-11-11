// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Threading.Tasks.Task Wait(System.Threading.Tasks.ValueTask pending) => pending.AsTask();
}
