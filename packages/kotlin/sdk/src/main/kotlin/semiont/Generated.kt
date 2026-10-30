package semiont

/** Marks what the generator writes from the spec. The ABI dump leaves it out: the spec fixes it, and the spec's own checks hold it. */
@Retention(AnnotationRetention.BINARY)
@Target(AnnotationTarget.CLASS, AnnotationTarget.PROPERTY)
internal annotation class Generated
