package launcher

import (
	"errors"
	"testing"
)

// The local stack's gateway is where its record says it is, on whatever port
// the config gave it; a record that names none has no address, and none is
// made up.
func TestGatewayBaseIsTheRecordedOneOrNone(t *testing.T) {
	recorded := &StackState{Services: map[string]ServiceState{"gateway": {Endpoint: "http://localhost:4100/api/health"}}}
	if base, err := GatewayBase(recorded); err != nil || base != "http://localhost:4100" {
		t.Errorf("a recorded gateway on 4100 gives %q, %v", base, err)
	}
	for name, st := range map[string]*StackState{
		"no gateway service":            {Services: map[string]ServiceState{}},
		"a gateway with no endpoint":    {Services: map[string]ServiceState{"gateway": {Container: "semiont-gateway"}}},
		"an endpoint that is no health": {Services: map[string]ServiceState{"gateway": {Endpoint: "tcp:localhost:4000"}}},
	} {
		base, err := GatewayBase(st)
		var none *NoGatewayRecorded
		if !errors.As(err, &none) || base != "" {
			t.Errorf("%s gives %q, %v; want no base and a *NoGatewayRecorded", name, base, err)
		}
	}
}
