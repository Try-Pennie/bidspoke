# Forwarding partner traffic into a Bidspoke workflow

How to wire an external Cloudflare proxy worker (the kind that sits in front of a
partner integration and routes leads into a Bidspoke custom endpoint) so it works
the first time. Written after the RML LendSwift cutover, where the same forward
that worked for Main Flow returned a 403 to the engine.

## The setup

The engine posts to a thin Cloudflare "proxy" worker on its own hostname (for
example `reservebidengine.trypennie.dev/bidding`). That worker inspects the lead,
decides where it goes, and forwards it into a Bidspoke custom endpoint at
`hook.trypennie.dev/<subdomain>/<path>` with an `X-API-Key`. Bidspoke runs the
workflow and returns the bid response, which the proxy passes straight back to the
engine.

Two facts about the Bidspoke side that drive everything below:

1. **Custom endpoints route on the `Host` header**, not the URL path the proxy
   dials. The router checks `host === 'hook.trypennie.dev'` (`index.ts`, the
   `isCustomEndpointHost` call). If the Host header is anything else, the request
   falls through to normal routing and you get a 404, never the endpoint you
   meant.
2. **A Bidspoke custom endpoint never returns 403.** It returns 401 (missing or
   invalid `X-API-Key`), 404 (unknown or inactive endpoint), 400 (bad JSON), or
   200/409/500 from the workflow. The only path in the whole worker that returns
   403 is the generic `/webhooks/:id` route hitting the source-to-workflow
   allow-list. So if your proxy logs a 403 on a forward to `hook.trypennie.dev`,
   the 403 did not come from the Bidspoke app. It came from Cloudflare's edge.

## Get it right the first time

### First check: match a known-good proxy's body handling

Before anything else, compare your forward against a proxy that already works
(Main Flow is the reference). The one behavioral difference that bit us was the
body.

The working proxy forwards the original request body untouched:

```js
return fetch(new Request(target, { method: req.method, headers, body: req.body }));
```

The broken proxy read the body first to make a routing decision, then forwarded
the stream:

```js
const body = await req.clone().json();   // consumes a clone of the stream
// ...route on body...
return fetch(new Request(target, { method: req.method, headers, body: req.body }));
```

If you need to inspect the body to route (most partner proxies do), read it
**once** into a variable and forward that buffered string. A buffered body sends a
real `Content-Length` instead of chunked transfer encoding, which makes the
forwarded request look identical to a manual `curl`:

```js
const raw = await req.text();            // read once
const body = JSON.parse(raw || '{}');    // route on it
// ...
return fetch(target, { method: req.method, headers, body: raw });  // forward the string
```

This is worth trying first because it is a one-line change and it rules out the
cheapest possible cause. In our case it was not the full fix, but it is the right
default and it is how the working proxy behaves.

### The robust fix: use a Service Binding, not a hostname

When the proxy and `bidspoke-worker` are on the **same Cloudflare account**, do not
forward by hostname at all. Bind the proxy directly to `bidspoke-worker` and call
it worker-to-worker. This skips DNS entirely, so the class of edge errors below
cannot happen, and it is faster.

Add the binding to the **proxy** worker (the caller), not Bidspoke:

- Dashboard: the proxy worker, Settings, Bindings, Add binding, Service binding.
  Variable name `BIDSPOKE`, service `bidspoke-worker`, Entrypoint `Default` (not
  the Durable Object classes in the dropdown).
- Or in `wrangler.toml`:
  ```toml
  [[services]]
  binding = "BIDSPOKE"
  service = "bidspoke-worker"
  ```

Then accept `env` and call the binding for the Bidspoke hop only:

```js
export default {
  async fetch(req, env) {
    // ...routing...
    return forwardToBidspoke(req, 'https://hook.trypennie.dev/<sub>/<path>', env);
  },
};

async function forwardToBidspoke(req, targetUrl, env) {
  const target = new URL(targetUrl);
  const headers = new Headers({ 'X-API-Key': API_KEY });
  headers.set('host', 'hook.trypennie.dev');   // router keys off this
  // ...passthrough headers (content-type, x-idempotency-key, x-trace-id, traceparent)...

  const upstream = await env.BIDSPOKE.fetch(new Request(target.toString(), {
    method: req.method,
    headers,
    body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null,
    redirect: 'follow',
  }));

  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: upstream.headers });
}
```

Keep any forwards to non-Bidspoke targets (Pipedream, partner APIs) on the global
`fetch`. They do not cross into `hook.trypennie.dev`, so they neither need the
binding nor hit the edge error.

The Host header still has to be `hook.trypennie.dev` even over a binding, because
the binding hands the request straight to `bidspoke-worker`'s fetch handler, which
routes on Host. Setting it on the `Request` is enough.

### Auth

The proxy must send an `X-API-Key` that exists in the Worker's `API_KEY_MAP` secret
and maps to the source name you want recorded. Custom endpoints are self-granting:
they run the workflow they are mapped to and skip the source-to-workflow
allow-list. The allow-list (and its 403) only applies to the generic
`/webhooks/:id` route, so it is not in play here, but it is the thing to remember
if a future partner sends to the generic webhook instead of a custom endpoint.

## Why the hostname forward fails: Cloudflare error 1014

The symptom that started the RML debug: the engine got a 403, and the proxy's own
log showed the forward returning `status: 403`, `server: cloudflare`, body
`error code: 1014`, in about 5ms with no real round trip.

`1014` is "CNAME Cross-User Banned." It is a DNS-layer rejection from Cloudflare's
edge, returned before the request reaches `bidspoke-worker` (which is why the
Bidspoke app, which cannot emit 403 on a custom endpoint, was never the source).
It is tied to how `hook.trypennie.dev` resolves (a proxied CNAME toward a
`workers.dev` target) and how the calling worker's subrequest is framed when it
re-enters that zone.

Two things made it confusing, both worth knowing:

- **A manual `curl` to the same URL works.** Cloudflare enforces the cross-user
  CNAME ban on requests that originate inside its own network (a worker
  subrequest). An external client gets normal proxied resolution and sails
  through. So "curl works" does not prove the worker forward will.
- **The Main Flow proxy forwards to the same `hook.trypennie.dev` and works**,
  on the same account. We did not get to the bottom of why the two differ at the
  DNS level. The one code difference was the body handling above. The Service
  Binding sidesteps the question completely, which is why it is the recommended
  fix rather than chasing the DNS config.

## Diagnosing a bad forward

If a forward misbehaves, instrument the proxy and read the **upstream** response.
The default `return fetch(...)` hides it, so await the response and log it:

```js
const upstream = await fetch(/* ... */);
const text = await upstream.text();
console.log(JSON.stringify({
  tag: 'forward_response',
  status: upstream.status,
  server: upstream.headers.get('server'),   // 'cloudflare' + an error-code body => edge, not the app
  bodyPreview: text.slice(0, 500),
}));
return new Response(text, { status: upstream.status, headers: upstream.headers });
```

Reading the response:

- `server: cloudflare` with a body like `error code: 1014` (or any `error code:
  NNNN`): the edge blocked it. Not an app problem. Use the Service Binding.
- A JSON body with an `error` field: the Bidspoke app answered. Read the message.
  401 means the `X-API-Key` is missing or not in `API_KEY_MAP`. 404 means the
  endpoint subdomain/path is wrong or inactive.

Where to find the logs:

- Console logs and the platform's request-summary event are **separate entries**.
  The big event with the full `cf` object is not your `console.log`. Correlate the
  two by `rayId` / `requestId`.
- Live tail: `wrangler tail <proxy-worker-name> --format pretty`, or the worker's
  Logs tab in the dashboard. You must be on the account that owns the proxy.

## Pre-flight checklist for a new partner forward

- Custom endpoint exists in `webhook_endpoints` and is active, with the right
  subdomain, path, source name, and target workflow.
- `X-API-Key` is in `API_KEY_MAP` and maps to the intended source.
- Forward sets `host: hook.trypennie.dev`.
- Body is read once and forwarded as a buffered string, or forwarded untouched.
  Not cloned-then-streamed.
- Bidspoke hop goes through a Service Binding when both workers share an account.
- Non-Bidspoke forwards stay on global `fetch`.
- One test lead returns 200 with a bid body and produces a row in
  `workflow_executions`.
