package semiont.registry

import kotlinx.serialization.Serializable
import semiont.identifiers.ResourceId

/** One resource open in a knowledge base: a tab, where there are tabs. */
@Serializable
public data class OpenResource(
    public val id: ResourceId,
    public val name: String,
    /** When it was opened, in milliseconds since the epoch. */
    public val openedAt: Long,
    /** Its place among the others. */
    public val order: Int,
    public val mediaType: String? = null,
    /** Where it is in the working tree, such as `file://docs/overview.md`; null when that is not known. */
    public val storageUri: String? = null,
)

/**
 * What checking one open resource against its knowledge base concluded: the
 * knowledge base said it does not exist, it has it and said what it is, or the
 * check failed some other way.
 */
public enum class TabVerdict(
    /** The verdict as every SDK spells it. */
    public val wire: String,
) {
    Gone("gone"),
    Ready("ready"),
    Unknown("unknown"),
}

/**
 * One open resource's verdict. `Gone` is the only verdict that removes, and it
 * means the knowledge base said the resource does not exist, not that the
 * check failed: a transport failure, a timeout and a peer that is down are all
 * `Unknown`, and an unknown resource stays open, since closing everything
 * because a service was briefly down would be worse than the stale entries
 * this removes. `name` and `mediaType` are what the knowledge base said of a
 * resource it has: a `Ready`'s alone.
 */
public data class TabCheck @JvmOverloads constructor(
    public val verdict: TabVerdict,
    public val name: String? = null,
    public val mediaType: String? = null,
)

/**
 * Apply each verdict to what is open: what is gone is dropped, what was found
 * takes its name and media type, and everything else is left as it was. One
 * with no verdict is left: it was opened while the checks were in flight.
 */
public fun applyTabChecks(opened: List<OpenResource>, checks: Map<ResourceId, TabCheck>): List<OpenResource> = opened.mapNotNull { tab ->
    val check = checks[tab.id]
    when {
        check?.verdict == TabVerdict.Gone -> null
        check?.verdict == TabVerdict.Ready && check.name != null -> tab.copy(name = check.name, mediaType = check.mediaType ?: tab.mediaType)
        else -> tab
    }
}

/** `resources` by the place each has, and among those given the same place, by when each was opened. */
public fun sortOpenResources(resources: List<OpenResource>): List<OpenResource> = resources.sortedWith(compareBy({ it.order }, { it.openedAt }))
