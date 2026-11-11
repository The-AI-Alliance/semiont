// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static async System.Threading.Tasks.Task Wait(System.Threading.Tasks.Task work) => await work.ConfigureAwait(System.Threading.Tasks.ConfigureAwaitOptions.SuppressThrowing);
}
