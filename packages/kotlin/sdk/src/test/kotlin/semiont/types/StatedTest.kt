package semiont.types

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** A member the spec says is optional and nullable is absent, null or a value: three things, each written as it was read. */
class StatedTest {
    private fun read(json: String) = wireJson.decodeFromString(GetAnnotationsResponse.serializer(), json)
    private fun written(response: GetAnnotationsResponse) = wireJson.encodeToString(GetAnnotationsResponse.serializer(), response)

    @Test
    fun absentIsAbsent() {
        val response = read("""{"annotations":[],"total":0}""")
        assertEquals(Stated.Absent, response.motivation)
        assertEquals("""{"annotations":[],"total":0.0}""", written(response))
    }

    @Test
    fun nullIsNull() {
        val response = read("""{"annotations":[],"total":0,"motivation":null}""")
        assertEquals(Stated.Null, response.motivation)
        assertEquals("""{"annotations":[],"total":0.0,"motivation":null}""", written(response))
    }

    @Test
    fun aValueIsThatValue() {
        val response = read("""{"annotations":[],"total":0,"motivation":"linking"}""")
        assertEquals(Stated.Value(Motivation.Linking), response.motivation)
        assertEquals("""{"annotations":[],"total":0.0,"motivation":"linking"}""", written(response))
    }
}
