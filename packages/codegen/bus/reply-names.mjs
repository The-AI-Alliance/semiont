// What each operation's reply states beside its `response`, derived from the
// component schema the reply carries. One derivation: generate-ts.mjs prints
// it as REPLY_NAMES, which core's FaultyTransport answers from.
//
// A reply names what it answers for by stating a property of its request
// again: the annotation or the resource a context was gathered for, the
// reference a search was for. Whoever answers takes each from the request, so
// a name the request does not state is one nothing could fill, and the
// derivation refuses it.

/** The keywords that state a schema's requirements somewhere other than its own `required`. */
const COMPOSITIONS = ['$ref', 'allOf', 'anyOf', 'oneOf'];

// An absent keyword as JSON Schema reads it: no `required` requires nothing,
// no `properties` states none.
const required = (schema) => schema.required ?? [];
const properties = (schema) => Object.keys(schema.properties ?? {});

/**
 * Each operation's request channel, with the properties its reply requires
 * beside `response`, in the order the reply's schema requires them. Every
 * operation has a list; most are empty.
 *
 * `schemaOf` reads a component schema by the name the registry gives it.
 */
export function replyNames(registry, schemaOf) {
  const byChannel = new Map(registry.channels.map((entry) => [entry.channel, entry]));
  const names = new Map();
  for (const { request, result } of registry.operations) {
    const named = requiredBesideResponse(byChannel.get(result), request, schemaOf);
    names.set(request, named);
    if (named.length === 0) continue;

    const asked = byChannel.get(request);
    const stated = asked.shape === 'schema' ? properties(schemaOf(asked.schema)) : [];
    const unstated = named.find((name) => !stated.includes(name));
    if (unstated !== undefined) {
      throw new Error(`registry: ${result} names "${unstated}" beside its response, which ${request} does not state`);
    }
  }
  return names;
}

function requiredBesideResponse(reply, request, schemaOf) {
  switch (reply.shape) {
    case 'schema': {
      const schema = schemaOf(reply.schema);
      const composed = COMPOSITIONS.find((keyword) => Object.hasOwn(schema, keyword));
      if (composed !== undefined) {
        throw new Error(
          `registry: ${reply.channel} carries ${reply.schema}, which is composed with ${composed}: ` +
            `what it requires is not read from its own \`required\``,
        );
      }
      return required(schema).filter((name) => name !== 'response');
    }
    // `{ response }` around a schema, or no payload: nothing beside the response.
    case 'envelope':
    case 'empty':
    case 'void':
      return [];
    default:
      throw new Error(
        `registry: ${reply.channel} is the reply to ${request} and has shape ${JSON.stringify(reply.shape)}, ` +
          `which states no response to name anything beside`,
      );
  }
}
