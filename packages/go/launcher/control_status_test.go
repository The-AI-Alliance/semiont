package launcher

import (
	"reflect"
	"testing"
)

func TestWorkloadStatusUsesHealthyServicesAndAvailableReadings(t *testing.T) {
	completed, failed := 10, 3
	service := func(role string, healthy bool) ControlServiceStatus {
		return ControlServiceStatus{Role: role, Healthy: healthy}
	}

	tests := []struct {
		name     string
		services []ControlServiceStatus
		readout  string
		want     ControlWorkloadStatus
	}{
		{
			name:     "gateway and dispatcher",
			services: []ControlServiceStatus{service("gateway", true), service("dispatcher", true)},
			readout:  sampleReadout,
			want: ControlWorkloadStatus{
				Ledger: &ControlWorkloadStatusLedger{Claims: 7, Capacity: 4096},
				Queue:  &ControlWorkloadStatusQueue{Pending: 3, Running: 2, Completed: &completed, Failed: &failed},
			},
		},
		{
			name:     "gateway only",
			services: []ControlServiceStatus{service("gateway", true), service("dispatcher", false)},
			readout:  sampleReadout,
			want:     ControlWorkloadStatus{Ledger: &ControlWorkloadStatusLedger{Claims: 7, Capacity: 4096}},
		},
		{
			name:     "dispatcher without outcome counters",
			services: []ControlServiceStatus{service("dispatcher", true)},
			readout: `semiont_job_queue_size{job="semiont-dispatcher",job_status="pending",semiont_kb="` + kbA + `"} 2
semiont_job_queue_size{job="semiont-dispatcher",job_status="running",semiont_kb="` + kbA + `"} 1`,
			want: ControlWorkloadStatus{Queue: &ControlWorkloadStatusQueue{Pending: 2, Running: 1}},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			readout := &lazyBody{body: test.readout, fetched: true}
			got := workloadStatus(stackView{}, kbA, test.services, readout)
			if !reflect.DeepEqual(got, &test.want) {
				t.Errorf("workload status = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestWorkloadStatusOmitsUnavailableReadings(t *testing.T) {
	service := func(role string, healthy bool) ControlServiceStatus {
		return ControlServiceStatus{Role: role, Healthy: healthy}
	}

	t.Run("no healthy reporting service does not read collector", func(t *testing.T) {
		readout := &lazyBody{body: sampleReadout}
		got := workloadStatus(stackView{}, kbA, []ControlServiceStatus{service("gateway", false), service("dispatcher", false)}, readout)
		if got != nil {
			t.Fatalf("workload status = %#v, want nil", got)
		}
		if readout.fetched {
			t.Fatal("read collector despite neither service being healthy")
		}
	})

	t.Run("status adapter handles no services", func(t *testing.T) {
		if got := workloadStatus(stackView{}, kbA, nil, &lazyBody{}); got != nil {
			t.Fatalf("workload status = %#v, want nil", got)
		}
	})

	t.Run("healthy services without readings", func(t *testing.T) {
		got := workloadStatus(stackView{}, kbA, []ControlServiceStatus{service("gateway", true), service("dispatcher", true)}, &lazyBody{fetched: true})
		if got != nil {
			t.Fatalf("workload status = %#v, want nil", got)
		}
	})
}
