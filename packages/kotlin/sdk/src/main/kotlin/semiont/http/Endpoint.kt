package semiont.http

import semiont.types.HttpEndpoint

private val label = Regex("[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?")

/**
 * Whether `host` is a host's name: labels of ASCII letters, digits and
 * hyphens with a dot between each two, every label 1 to 63 characters long
 * and none beginning or ending with a hyphen. `localhost` and a dotted address
 * are such names; a host with a slash, a colon or a query is not.
 */
public fun isValidHostname(host: String): Boolean = host.split('.').all { label.matches(it) }

/**
 * The origin of a knowledge base's gateway: the protocol, the host in
 * lowercase and nothing else done to it, and the port, written even when it
 * is the protocol's own. Throws `IllegalArgumentException` when the host is
 * no host's name: a name a person typed is never put into a URL unread.
 */
public fun gatewayUrl(endpoint: HttpEndpoint): String {
    require(isValidHostname(endpoint.host)) { "Invalid KB hostname: \"${endpoint.host}\"" }
    return "${endpoint.protocol.value}://${endpoint.host.lowercase()}:${endpoint.port}"
}
