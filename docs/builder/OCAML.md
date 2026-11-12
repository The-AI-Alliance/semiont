# Build with the OCaml SDK

Start with the [OCaml SDK README](../../packages/ocaml/sdk/README.md) to build and install the library. The examples use `Semiont.Client` from an Eio application.

## Connect and manage lifetimes

Create the client inside an Eio switch. Pass your gateway adapter to `Client.connect`; it receives the method, relative path, headers, and request body and returns the status, headers, and streaming response body. The adapter resolves requests against the selected gateway and handles TLS. Give `Client.connect` the channels its bus subscribes to as `~global`; it assumes none of its own. A full client gives it `Bus_registry.bridged_channels`, generated from the registry, and a worker gives it its own.

For a script, use device sign-in or a saved launcher credential. For an interactive client, use the registry's durable redirect flow. `Registry.start_kept_session` builds the credential session for a registered knowledge base, and `State_units.Session.make` exposes the current credential, confirmed principal, and stream state. `State_units.Session.errors` says the session's own errors and its client's failures, in the order met. When the application is finished, close the client first and then dispose the session state, so what the client's closing flush meets is said before the errors end.

## Read and observe a resource

Parse a resource identifier with `Identifiers.Resource_id.of_string`. Pass the identifier and your client to `Client.Browse.resource`. Read with `Client.fresh` or subscribe with `Client.observe`. The observation returns a release function. Call it when the view closes.

See the [compiled builder example](../../packages/ocaml/sdk/examples/builder.ml) for a live resource observation and a delegated marking request. The example uses the existing client and returns the observation or job release function to the caller.

## Delegate and follow a job

Decode marking parameters with `Models.decode Models.mark_job_params`. Call `Client.Mark.delegate` with the resource, parameters, and report callbacks. To generate a resource, use `Models.generation_job_request` and `Client.Yield.delegate`. Use the Mark and Yield state units when a view needs to keep progress and terminal outcomes until dismissal.
