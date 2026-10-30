// refused: argument type mismatch: actual type is 'ScopedChannel<EnrichedResourceEvent>', but 'Channel<uninferred P (of fun <P> frames)>' was expected
// A channel of a resource's frames is read for a resource.
import semiont.SemiontClient
import semiont.channels.Channels

fun everyResource(client: SemiontClient) = client.wire.frames(Channels.MARK_ADDED)
