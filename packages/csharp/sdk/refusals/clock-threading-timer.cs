// expect: SEM007
public static class Refusal
{
public static System.Threading.Timer Ticks() => new(_ => { }, null, 0, 1000);
}
