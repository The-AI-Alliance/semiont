//! The stream's framing (docs/protocol/TRANSPORT-HTTP.md § Wire framing and
//! client parser obligations): `text/event-stream`, each event an `event`
//! line, an `id` line and one `data` line, ended by a blank line.
//!
//! The parser holds its state across reads. One event can span many reads of
//! the connection, and a read can end anywhere: inside a line, between a line
//! and its blank line, inside a character. So it keeps bytes until a line is
//! whole and decodes a line only then, and it scans each read once, however
//! long the line it belongs to has grown.

/// One event of the stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub id: Option<String>,
    pub data: String,
}

#[derive(Default)]
pub struct SseParser {
    /// The bytes of the line not yet ended.
    line: Vec<u8>,
    event: String,
    id: Option<String>,
    data: Option<String>,
}

impl SseParser {
    pub fn new() -> SseParser {
        SseParser::default()
    }

    /// Take the next bytes read; give the events they complete.
    pub fn feed(&mut self, mut bytes: &[u8]) -> Vec<SseEvent> {
        let mut events = Vec::new();
        while let Some(end) = bytes.iter().position(|b| *b == b'\n') {
            self.line.extend_from_slice(&bytes[..end]);
            bytes = &bytes[end + 1..];
            let line = std::mem::take(&mut self.line);
            if let Some(event) = self.line_ended(&line) {
                events.push(event);
            }
        }
        self.line.extend_from_slice(bytes);
        events
    }

    fn line_ended(&mut self, line: &[u8]) -> Option<SseEvent> {
        let line = String::from_utf8_lossy(line);
        let line = line.strip_suffix('\r').unwrap_or(&line);
        if line.is_empty() {
            let event = SseEvent {
                event: std::mem::take(&mut self.event),
                id: self.id.take(),
                data: self.data.take().unwrap_or_default(),
            };
            return (!event.event.is_empty() || !event.data.is_empty() || event.id.is_some())
                .then_some(event);
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.event = value.to_owned(),
            "id" => self.id = Some(value.to_owned()),
            "data" => match self.data.as_mut() {
                Some(data) => {
                    data.push('\n');
                    data.push_str(value);
                }
                None => self.data = Some(value.to_owned()),
            },
            _ => {}
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STREAM: &str = "event: bus-event\nid: e-beckon:focus:1\ndata: {\"channel\":\"beckon:focus\",\"payload\":{\"annotationId\":\"naïve — 日本語 😀\"}}\n\nevent: ping\ndata:\n\nevent: bus-event\nid: p-res-1-2\ndata: {\"channel\":\"mark:added\",\"payload\":{},\"scope\":\"res-1\"}\n\n";

    fn whole() -> Vec<SseEvent> {
        SseParser::new().feed(STREAM.as_bytes())
    }

    #[test]
    fn a_stream_read_at_once_gives_its_events() {
        let events = whole();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].event, "bus-event");
        assert_eq!(events[0].id.as_deref(), Some("e-beckon:focus:1"));
        assert!(events[0].data.contains("naïve — 日本語 😀"));
        assert_eq!(
            events[1],
            SseEvent {
                event: "ping".to_owned(),
                id: None,
                data: String::new()
            }
        );
        assert_eq!(events[2].id.as_deref(), Some("p-res-1-2"));
    }

    /// However the reads fall, the events are the same: every split point,
    /// and every size of read down to a byte, which splits lines, blank
    /// lines and characters.
    #[test]
    fn the_events_do_not_depend_on_where_the_reads_fall() {
        let bytes = STREAM.as_bytes();
        for split in 0..=bytes.len() {
            let mut parser = SseParser::new();
            let mut events = parser.feed(&bytes[..split]);
            events.extend(parser.feed(&bytes[split..]));
            assert_eq!(events, whole(), "split at {split}");
        }
        for size in 1..=7 {
            let mut parser = SseParser::new();
            let events: Vec<SseEvent> = bytes
                .chunks(size)
                .flat_map(|read| parser.feed(read))
                .collect();
            assert_eq!(events, whole(), "reads of {size}");
        }
    }

    #[test]
    fn a_carriage_return_before_the_newline_is_not_part_of_the_line() {
        let events = SseParser::new().feed(b"event: bus-event\r\ndata: {}\r\n\r\n");
        assert_eq!(
            events,
            [SseEvent {
                event: "bus-event".to_owned(),
                id: None,
                data: "{}".to_owned()
            }]
        );
    }
}
