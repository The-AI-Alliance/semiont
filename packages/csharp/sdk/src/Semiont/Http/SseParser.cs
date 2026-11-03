using System.Text;

namespace Semiont.Http;

internal sealed record SseEvent(string Event, string? Id, string Data);

internal sealed class SseParser
{
    private readonly MemoryStream line = new();
    private readonly StringBuilder data = new();
    private string eventName = "message";
    private string? id;
    private bool hasData;

    internal IReadOnlyList<SseEvent> Feed(ReadOnlySpan<byte> bytes)
    {
        var events = new List<SseEvent>();
        foreach (var value in bytes)
        {
            if (value != (byte)'\n')
            {
                line.WriteByte(value);
                continue;
            }
            var text = Encoding.UTF8.GetString(line.GetBuffer(), 0, checked((int)line.Length)).TrimEnd('\r');
            line.SetLength(0);
            if (text.Length == 0)
            {
                if (hasData)
                {
                    events.Add(new SseEvent(eventName, id, data.ToString()));
                }
                eventName = "message";
                id = null;
                hasData = false;
                data.Clear();
                continue;
            }
            if (text[0] == ':')
            {
                continue;
            }
            var colon = text.IndexOf(':');
            var field = colon < 0 ? text : text[..colon];
            var content = colon < 0 ? "" : text[(colon + 1)..];
            if (content.StartsWith(' '))
            {
                content = content[1..];
            }
            switch (field)
            {
                case "event": eventName = content; break;
                case "id": id = content; break;
                case "data":
                    if (hasData)
                    {
                        data.Append('\n');
                    }
                    data.Append(content);
                    hasData = true;
                    break;
            }
        }
        return events;
    }
}
