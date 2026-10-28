package state

// A pointer's dwell: an annotation is hovered once the pointer has rested on
// it, and no longer the moment it leaves.
//
// A pointer crossing the page hovers nothing on its way. say is told each
// change: the annotation hovered, or nil for none. Beckon.Hover is what it is
// usually given, and Timing.HoverDelay the delay, unless the viewer was told
// another. Closing it forgets a rest that has not run its time, and it says
// nothing more.

import (
	"sync"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// HoverDwell is a pointer's dwell: see the file's documentation.
type HoverDwell struct {
	say   func(annotationID *api.AnnotationId)
	delay time.Duration

	mu     sync.Mutex
	closed bool
	// hovering is what was last said to be hovered; the zero AnnotationId for
	// none.
	hovering api.AnnotationId
	// resting is the rest that has not run its time yet, and rests counts
	// them, so a rest that ran out as it was interrupted knows it was.
	resting *time.Timer
	rests   int
}

var _ semiont.StateUnit = (*HoverDwell)(nil)

// NewHoverDwell is a dwell that tells say what is hovered once the pointer
// has rested for delay. say is told with the dwell's lock held, so what it is
// told is in order; it does not call the dwell back.
func NewHoverDwell(say func(annotationID *api.AnnotationId), delay time.Duration) *HoverDwell {
	return &HoverDwell{say: say, delay: delay}
}

// Enter says the pointer is on an annotation: hovered once the pointer has
// stayed for the delay. One already hovered is not said again.
func (d *HoverDwell) Enter(annotationID api.AnnotationId) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || d.hovering == annotationID {
		return
	}
	d.interrupt()
	rest := d.rests
	d.resting = time.AfterFunc(d.delay, func() { d.rested(rest, annotationID) })
}

// Leave says the pointer left. Said at once, and only when something was
// hovered.
func (d *HoverDwell) Leave() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return
	}
	d.interrupt()
	if !d.hovering.IsZero() {
		d.hovering = api.AnnotationId{}
		d.say(nil)
	}
}

// rested is a rest that ran its time, unless it was interrupted first.
func (d *HoverDwell) rested(rest int, annotationID api.AnnotationId) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || rest != d.rests {
		return
	}
	d.resting = nil
	d.hovering = annotationID
	d.say(&annotationID)
}

// interrupt forgets the rest under way. Called with mu held.
func (d *HoverDwell) interrupt() {
	if d.resting != nil {
		d.resting.Stop()
		d.resting = nil
	}
	d.rests++
}

// Close ends the dwell: a rest not yet run out is forgotten, and nothing more
// is said. Closing twice is closing once.
func (d *HoverDwell) Close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.closed = true
	d.interrupt()
}
