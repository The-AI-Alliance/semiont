// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static bool Start(System.Action work) => System.Threading.ThreadPool.QueueUserWorkItem(_ => work());
}
