/// Whether `left` comes before `right` in the order of their code points, the order the protocol
/// gives names in.
func byCodePoint(_ left: String, _ right: String) -> Bool {
  left.unicodeScalars.lexicographicallyPrecedes(right.unicodeScalars)
}
