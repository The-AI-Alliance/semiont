package bus

// FrameRefusalReason is why a value is refused at a member, as every SDK
// names a fault (packages/codegen/schemas/required-shapes.mjs): the reason a
// refused frame states, and the reason of every other fault this SDK finds.
type FrameRefusalReason string

const (
	// FrameRefusalReasonLacks: the value does not carry the member, or the
	// member holds null where it may not.
	FrameRefusalReasonLacks FrameRefusalReason = "lacks"
	// FrameRefusalReasonMalformed: the member is not what its schema allows
	// (of another kind, another value, form or size), or is one a closed
	// object does not name.
	FrameRefusalReasonMalformed FrameRefusalReason = "malformed"
)
