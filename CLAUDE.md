# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`lnd-async` is a small npm library: a promise-based gRPC client for the Lightning Network Daemon (LND), built on `@grpc/grpc-js` + `@grpc/proto-loader`. There is no build step; `lib/` is shipped as-is (`main: lib/lnd-async`). The README states which LND version the bundled protos match.

## Commands

```bash
npm install
npm test                                                     # mocha test/**/*.js -r dotenv/config
npx mocha test/lnd-async.spec.js -r dotenv/config -g getInfo # single test by name
```

- **Tests hit a real LND node.** There are no mocks; `test/lnd-async.spec.js` connects using `LND_ASYNC_TEST_LND_HOST`, `_LND_PORT`, `_MACAROON` (base64), `_MACAROON_PATH`, `_CERT` (base64), `_CERT_PATH`, `_NO_CERT=true` from a git-ignored `.env` (loaded via `-r dotenv/config`). Unset values fall back to the library defaults (`localhost:10009`, OS-default `~/.lnd` paths).
- Tests only check that unary methods return a Promise and stream methods return a stream (with a 500 ms deadline / 200 ms cancel). The method list is deliberately limited to read-only calls; **never add methods that change node state** (send, open/close channel, settle, etc.) because the suite runs against a live node.
- No `lint` script. `npx eslint lib test` currently fails to parse `lib/common.js` (object spread) and `lib/generate-all-api-object.js` (`for await`) because `.eslintrc` pins `ecmaVersion: 8`.
- Style (`.prettierrc`, `.eslintrc`): 2 spaces, single quotes, semicolons, width 100. `lib/generate-all-api-object.js` is a dev script and does not follow this.
- The npm package is limited by `"files": ["lib"]` in `package.json`; anything outside `lib/` (tests, util-scripts, local files) is not published. Check `npm pack --dry-run` before publishing.

## Architecture

The call path is `lnd-async.js` → `lnd-rpc.js` → generated `all-api.js` + the `.proto` files.

- **`lib/lnd-rpc.js`** builds credentials (TLS cert from path or base64, or `noCert` for a publicly-signed cert; macaroon from path or base64 sent as hex `macaroon` metadata, skipped with `noMacaroons`), then loads **every** proto listed in `all-api.js` from `lib/original-lnd-protos/` and instantiates one grpc-js client per service against the same `host:port`. Loader options matter to callers: `keepCase: true` (fields stay snake_case, e.g. `r_hash`), `enums: String`, `defaults: true`, `oneofs: true`, and `longs: String` unless `longsAsNumbers` is set. Loaded service constructors are cached per `longs` type. Google API annotation protos are resolved from the `protobufjs` package directory via `includeDirs`.
- **`lib/lnd-async.js`** wraps the raw clients into the object returned by `connect()`:
  - `client.<method>`: a flat legacy surface holding the methods of the `Lightning`, `WalletUnlocker` and `State` services only.
  - `client.<ServiceName>.<method>`: every service, keyed by **service name** (`client.Router`, `client.Invoices`, `client.WalletKit`, `client.WatchtowerClient`...), not by proto package.
  - `client.lnrpc`: the raw grpc-js clients (`services` for the legacy three, `allServices` for all).
  - Unary RPCs are `promisify`-ed; server-streaming RPCs are returned bound but unwrapped (caller gets a grpc stream). Method names are lowerCamelCase.
- **`lib/common.js`** derives the lookup sets (`streamApis`/`callbackApis` for the flat surface, `allStreamApi`/`allCallbackApi` keyed `Service.method`) from `all-api.js`. A method that is not listed in `all-api.js` is **silently absent** from the wrapped client, and stream vs. promise is decided by this list, not by grpc metadata.
- **`lib/all-api.js` is generated, do not hand-edit.** `lib/generate-all-api-object.js` regex-parses each `.proto` for `package`, `service` and `rpc X (...) returns (stream ...)` (handles a signature split over two lines). Keys are paths relative to `original-lnd-protos/` (e.g. `routerrpc/router.proto`), walked in sorted order so the output is deterministic and its diff shows only API changes. It assumes **one service per proto file** (throws otherwise) and drops files without a service (e.g. `lnclipb/lncli.proto`).

## Updating to a new LND version

Protos in `lib/original-lnd-protos/` are verbatim copies of `lnrpc/` from the LND repo.

```bash
./util-scripts/run-all.sh /path/to/lnd   # = copy-proto-files.sh <lnd> + generate-all-api-object.sh
```

`copy-proto-files.sh` rsyncs only `*.proto` (default source `extra/lnd`); `generate-all-api-object.sh` must run from the repo root (it `cd`s into `lib/original-lnd-protos` and writes `lib/all-api.js`). After regenerating, check the `all-api.js` diff for new or removed services, since a new proto file with a service automatically becomes a new `client.<ServiceName>` namespace. Release commits then bump `version` in `package.json`, update the "supports LND version" line in `README.md`, and add an entry to its `## Versions` list.
