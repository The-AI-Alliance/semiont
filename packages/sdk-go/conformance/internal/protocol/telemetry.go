package protocol

// A driver started with OTEL_EXPORTER_OTLP_ENDPOINT in its environment
// exports the SDK's telemetry there over OTLP/HTTP, and has exported all of
// it by the time it exits (tests/conformance/sdk/README.md). Only the drivers
// take OpenTelemetry's SDK and its exporters: the Go SDK takes the API alone.

import (
	"context"
	"errors"
	"fmt"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// Exporting installs telemetry exported over OTLP/HTTP when the suite says
// where, and gives what sends the last of it, which the driver calls before it
// exits. exporting is false when the suite names nowhere: nothing is
// installed, and there is nothing to send. The exporters read the endpoint
// from the environment themselves.
func Exporting() (flush func(), exporting bool) {
	if _, named := os.LookupEnv("OTEL_EXPORTER_OTLP_ENDPOINT"); !named {
		return nil, false
	}
	ctx := context.Background()
	spans, err := otlptracehttp.New(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "no span exporter: %v\n", err)
		os.Exit(2)
	}
	counts, err := otlpmetrichttp.New(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "no metric exporter: %v\n", err)
		os.Exit(2)
	}
	described := resource.NewSchemaless(attribute.String("service.name", "semiont-conformance-driver"))
	tracers := sdktrace.NewTracerProvider(sdktrace.WithBatcher(spans), sdktrace.WithResource(described))
	meters := sdkmetric.NewMeterProvider(sdkmetric.WithReader(sdkmetric.NewPeriodicReader(counts)), sdkmetric.WithResource(described))
	// As an application turns tracing on: its providers, and W3C's propagator,
	// which the SDK reads to carry a trace.
	otel.SetTracerProvider(tracers)
	otel.SetMeterProvider(meters)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	return func() {
		// What could not be sent is said, and the driver exits failing: the
		// suite reads what arrived only from a driver that exited cleanly.
		if err := errors.Join(tracers.Shutdown(ctx), meters.Shutdown(ctx)); err != nil {
			fmt.Fprintf(os.Stderr, "telemetry not all sent: %v\n", err)
			os.Exit(1)
		}
	}, true
}
