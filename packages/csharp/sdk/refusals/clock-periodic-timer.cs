// expect: SEM007
public static class Refusal
{
public static System.Threading.PeriodicTimer Ticks() => new(System.TimeSpan.FromSeconds(1));
}
