# Archivist maintenance tools

`cleanup-missing-storage-events.ts` is a manual filesystem maintenance tool for
resource event streams whose storage file is missing. Without `--confirm` it reports
candidates; `--confirm` deletes their streams. It is not part of builds or startup.

The tool replays creation, move, and archive events. Review its report against the
knowledge base before requesting deletion, especially for resources with multiple
representations, which this older tool does not enumerate.
