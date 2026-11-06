// expect: SEM007
public static class Refusal
{
public static System.Threading.CancellationTokenSource Deadline() => new(System.TimeSpan.FromSeconds(1));
}
