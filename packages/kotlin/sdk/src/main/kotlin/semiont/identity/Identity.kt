package semiont.identity

import semiont.identifiers.UserId

/** What ECMAScript's `encodeURIComponent` leaves alone, beside ASCII letters and digits. */
private const val UNRESERVED = "-_.!~*'()"

/** `value` as `encodeURIComponent` writes it: each UTF-8 byte of every other character as `%XX`, in uppercase hex. */
public fun encodeUriComponent(value: String): String = buildString {
    for (byte in value.toByteArray(Charsets.UTF_8)) {
        val c = byte.toInt() and 0xff
        if (c < 0x80 && (c.toChar().isLetterOrDigit() || c.toChar() in UNRESERVED)) append(c.toChar()) else append("%%%02X".format(c))
    }
}

/** The knowledge base's DID: `did:web:` and its domain as it is, which is already a colon path. */
public fun kbDid(domain: String): UserId = UserId("did:web:$domain")

/** The knowledge base's resource identifier, the audience its tokens carry: its DID as an https URL. */
public fun kbResource(domain: String): String = "https://${domain.replace(':', '/')}"

/** A person, named by the subject the issuer asserted (principals/cases.json). */
public fun personDid(domain: String, subject: String): UserId = UserId("did:web:$domain:users:${encodeUriComponent(subject)}")

/** An agent, named by the subject its issuer asserted for its account, as a person is (principals/cases.json). */
public fun agentDid(domain: String, subject: String): UserId = UserId("did:web:$domain:agents:${encodeUriComponent(subject)}")
