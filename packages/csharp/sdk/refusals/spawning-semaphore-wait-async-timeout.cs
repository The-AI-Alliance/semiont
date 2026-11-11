// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Threading.Tasks.Task<bool> Turn(System.Threading.SemaphoreSlim turn) => turn.WaitAsync(System.TimeSpan.FromSeconds(1));
}
