// expect: SEM007
public static class Refusal
{
public static System.TimeSpan Elapsed(System.Action work) { var watch = System.Diagnostics.Stopwatch.StartNew(); work(); return watch.Elapsed; }
}
