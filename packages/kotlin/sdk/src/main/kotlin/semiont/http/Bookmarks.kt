package semiont.http

import semiont.identifiers.ResourceId

/**
 * Where a stream's place in each scope is kept across a client's lives. A
 * client that starts with the places its last life reached is sent what was
 * recorded since, and what it kept of those scopes is brought up to date by
 * replay.
 */
public interface Bookmarks {
    /** The id of the last recorded event delivered on each scope, as kept. */
    public fun load(): Map<ResourceId, String>

    /** A recorded event was delivered on `scope`. */
    public fun save(scope: ResourceId, eventId: String)
}
