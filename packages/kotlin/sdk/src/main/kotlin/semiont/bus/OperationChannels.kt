package semiont.bus

/** An operation of the bus registry: the channel its request goes on, and the channels its result and its failure come back on. */
internal data class OperationChannels(val request: String, val result: String, val failure: String)
