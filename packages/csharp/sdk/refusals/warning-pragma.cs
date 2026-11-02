// expect: SEM004
public static class Refusal
{
#pragma warning disable CS8603
public static string Read(string? value) => value;
}
