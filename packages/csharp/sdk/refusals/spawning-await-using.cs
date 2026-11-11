// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static async System.Threading.Tasks.Task Close(System.IAsyncDisposable resource) { await using var closing = resource; }
}
