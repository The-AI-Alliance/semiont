// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Threading.Tasks.Task<System.Threading.Tasks.Task> First(System.Threading.Tasks.Task one, System.Threading.Tasks.Task other) => System.Threading.Tasks.Task.WhenAny(one, other);
}
