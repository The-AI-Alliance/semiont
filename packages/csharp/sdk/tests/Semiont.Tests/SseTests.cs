using System.Text;
using Semiont.Http;
using Xunit;

namespace Semiont.Tests;

public sealed class SseTests
{
    [Fact]
    public void EveryByteBoundaryPreservesUnicodeAndMultilineFrames()
    {
        var bytes = Encoding.UTF8.GetBytes(": heartbeat\r\nevent: frame\r\nid: e-1\r\ndata: héllo 🌱\r\ndata: second\r\n\r\ndata:\n\nid: no-data\n\ndata: final\n\n");
        for (var boundary = 0; boundary <= bytes.Length; boundary++)
        {
            var parser = new SseParser();
            var events = parser.Feed(bytes.AsSpan(0, boundary)).Concat(parser.Feed(bytes.AsSpan(boundary))).ToArray();
            Assert.Equal(3, events.Length);
            Assert.Equal(new SseEvent("frame", "e-1", "héllo 🌱\nsecond"), events[0]);
            Assert.Equal(new SseEvent("message", null, ""), events[1]);
            Assert.Equal(new SseEvent("message", null, "final"), events[2]);
        }
    }

    [Fact]
    public void ByteAtATimeDoesNotPublishAnIncompleteEvent()
    {
        var parser = new SseParser();
        var events = new List<SseEvent>();
        foreach (var value in Encoding.UTF8.GetBytes("event: frame\nid: r-2\ndata: café\n\ndata: incomplete"))
        {
            events.AddRange(parser.Feed([value]));
        }
        Assert.Equal(new SseEvent("frame", "r-2", "café"), Assert.Single(events));
    }
}
