// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Threading.Tasks.Task<int> Read(System.Threading.Tasks.ValueTask<int> pending) => pending.AsTask();
}
