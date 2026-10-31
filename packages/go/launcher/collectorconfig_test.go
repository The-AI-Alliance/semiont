package launcher

import (
	"testing"

	"go.yaml.in/yaml/v3"
)

// The readout labels each series with the resource that exported it, so a
// series names its knowledge base (`semiont_kb`) and two knowledge bases'
// dispatchers are two series, not one — with Jaeger running or without.
func TestTheCollectorLabelsEachSeriesWithItsResource(t *testing.T) {
	for _, traces := range []bool{false, true} {
		rendered := collectorConfig("192.168.64.1", traces)
		var config struct {
			Exporters struct {
				Prometheus struct {
					ResourceToTelemetryConversion struct {
						Enabled bool `yaml:"enabled"`
					} `yaml:"resource_to_telemetry_conversion"`
				} `yaml:"prometheus"`
			} `yaml:"exporters"`
			Service struct {
				Pipelines struct {
					Metrics struct {
						Exporters []string `yaml:"exporters"`
					} `yaml:"metrics"`
				} `yaml:"pipelines"`
			} `yaml:"service"`
		}
		if err := yaml.Unmarshal([]byte(rendered), &config); err != nil {
			t.Fatal(err)
		}
		if !config.Exporters.Prometheus.ResourceToTelemetryConversion.Enabled {
			t.Errorf("traces=%v: the prometheus exporter does not carry the resource as labels:\n%s", traces, rendered)
		}
		if len(config.Service.Pipelines.Metrics.Exporters) != 1 || config.Service.Pipelines.Metrics.Exporters[0] != "prometheus" {
			t.Errorf("traces=%v: the metrics pipeline exports to %v, not the readout alone:\n%s", traces, config.Service.Pipelines.Metrics.Exporters, rendered)
		}
	}
}
