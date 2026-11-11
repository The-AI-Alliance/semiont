// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Threading.Thread Start(System.Threading.ThreadStart work) => new(work);
}
