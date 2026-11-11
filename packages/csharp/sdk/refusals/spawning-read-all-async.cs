// expect: SEM008
namespace Semiont;

internal static class Spawning
{
}

public static class Refusal
{
public static System.Collections.Generic.IAsyncEnumerable<int> Read(System.Threading.Channels.ChannelReader<int> reader) => reader.ReadAllAsync();
}
