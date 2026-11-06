// expect: SEM007
public static class Refusal
{
public static void Limit(System.Net.Http.HttpClient client) => client.Timeout = System.TimeSpan.FromSeconds(5);
}
