package state

// Attention, as this viewer's state: which annotation is hovered.
//
// It hears the viewer's hover (Beckon.Hover) and holds it, and sparkles an
// annotation the moment it is hovered. It hears an annotation opened, by this
// viewer or by another participant driving it, and turns the viewer's focus
// to it.

import (
	"github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// BeckonStateUnit is attention, as this viewer's state: see the file's
// documentation.
type BeckonStateUnit struct {
	client *semiont.Client
	life

	hovered *semiont.Variable[api.AnnotationId]
}

var _ semiont.StateUnit = (*BeckonStateUnit)(nil)

// NewBeckonStateUnit is a unit of attention over client. It hears the
// client's own bus from now on.
func NewBeckonStateUnit(client *semiont.Client) *BeckonStateUnit {
	u := &BeckonStateUnit{client: client, life: newLife(), hovered: semiont.NewVariable(api.AnnotationId{})}
	// One reader of both, taken now, so what is said from here on is heard in the order it was said.
	u.listen(client.Bus.FramesAmong(u.alive, bus.BeckonHover.Channel(), bus.BrowseClick.Channel()), u.heard)
	return u
}

// HoveredAnnotationId is the annotation this viewer hovers, or the zero
// AnnotationId when it hovers none.
func (u *BeckonStateUnit) HoveredAnnotationId() semiont.Watched[api.AnnotationId] {
	return u.hovered
}

// Focus signals: turn this viewer's focus to an annotation.
func (u *BeckonStateUnit) Focus(annotationID api.AnnotationId) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return
	}
	u.focus(annotationID)
}

// focus says the focus. Called with mu held.
func (u *BeckonStateUnit) focus(annotationID api.AnnotationId) {
	_ = semiont.Publish(u.client.Bus, bus.BeckonFocus, api.BeckonFocusEvent{AnnotationId: &annotationID}, semiont.Envelope{})
}

// heard acts on a hover or a click. A frame that is not its channel's is
// nobody's to act on.
func (u *BeckonStateUnit) heard(frame semiont.Frame) {
	switch frame.Channel {
	case bus.BeckonHover.Channel():
		hover, err := semiont.Decoded(bus.BeckonHover, frame)
		if err != nil {
			return
		}
		if hover.Payload.AnnotationId == nil {
			u.hovered.Set(api.AnnotationId{})
			return
		}
		hovered := *hover.Payload.AnnotationId
		u.hovered.Set(hovered)
		_ = semiont.Publish(u.client.Bus, bus.BeckonSparkle, api.BeckonSparkleEvent{AnnotationId: hovered}, semiont.Envelope{})
	case bus.BrowseClick.Channel():
		click, err := semiont.Decoded(bus.BrowseClick, frame)
		if err == nil {
			u.focus(click.Payload.AnnotationId)
		}
	}
}

// Close ends the unit: it hears nothing more and says nothing more, and what
// is hovered ends. Closing twice is closing once.
func (u *BeckonStateUnit) Close() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !u.close() {
		return
	}
	u.hovered.End()
}
