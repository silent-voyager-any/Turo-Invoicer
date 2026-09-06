# Development, testing, and release

[Documentation index](README.md)

## Workspace

The Git repository root contains the license and overview. The extension and its package file live in `Turo Invoicer/`. Run commands from that directory:

```sh
npm test
npm run check
```

There are no npm dependencies, bundler, transpiler, or required build outputs. Node.js 20+ is declared for development; Chrome 111+ is the manifest minimum. These minima are declarations, not an exhaustive compatibility test matrix.

## Test inventory

The current suite has 89 tests across:

- `tests/reconciler.test.js`: time zones, DST folds/gaps, calendar validity, amounts, intervals, canonical identifiers, mappings, grace, immutability.
- `tests/content.test.js`: field reduction, DOM fallbacks, bridge validation, delayed insertion, attribute hydration, network wakeup, settling, cancellation, concurrent waiters, container isolation.
- `tests/background.test.js`: trusted popup/dashboard senders, atomic state, failed-source preservation, serialized operations, schema migration, autosaved drafts, dated-assignment overlap rejection, settings and clearing.
- `tests/network.test.js`: fetch response preservation, path/domain filtering, XHR reuse, malformed JSON, exact-page gating, and request-start provenance.
- `tests/popup.test.js`: dashboard launching, source counts, sync status, and clear-data behavior.
- `tests/dashboard.test.js`: draft persistence, vehicle cards, mapping prefill, unique review counts, date bounds, and assignment commands.
- `tests/workspace.test.js`: trip-centric grouping, confirmed-vehicle gating, sent-fingerprint exclusion, persisted toll/trip selection, and cent totals.
- Additional history cases cover completed-only intervals, off-route rejection, and old-state invalidation; E-ZPass cases cover delayed rows, header variants, mixed identifiers, and posted-only rejection.
- Detail-read cases cover synthetic `baseTripCard` discovery, generated endpoint allowlists, exact reservation identity, nested epoch and local timestamps, conflicting or malformed JSON, response type/size/URL validation, concurrency, cancellation, failures, and avoiding unnecessary GETs. The synthetic fixture mirrors the field shape inspected in an authenticated browser without retaining account data.

The check script verifies manifest declarations, referenced files, intended permissions, and root JavaScript syntax. It does not lint everything, validate documentation, run Chrome, or authenticate portal accounts. Content tests use hand-built DOM mocks; they cannot prove that selector candidates match the live portal.

## Changing an adapter

1. Establish the exact failure: missing request, wrong path filter, new JSON shape, missing DOM selector, unsupported time, or mismatched identity.
2. Inspect a permitted signed-in session locally. Do not export credentials or raw account activity.
3. Create a synthetic fixture retaining relevant structure, identifiers, and timestamp formatting.
4. Add a failing regression test.
5. Make the smallest adapter change:
   - response selection: `network_hook.js`;
   - schema aliases and DOM fields: the source content script;
   - history-linked detail discovery, endpoint allowlisting, bounded GETs and JSON parsing: `turo_details.js`;
   - observer/reply lifecycle: `content_common.js`;
   - canonical normalization: `reconciler.js`.
6. Re-run tests/checks, reload the extension and tabs, and manually compare source counts and values.
7. Document new assumptions and unsupported cases.

Use semantic attributes and stable links before generated classes. Keep card boundaries narrow: never combine fields from separate trips. Preserve exact IDs. Never infer a missing vehicle ID from a model/name or use E-ZPass IDs as Turo IDs.

Verify currency units and passage timestamps. Do not broaden endpoint capture or host access merely to make an empty-result error disappear. Keep time parsing deterministic and reject ambiguous inputs rather than using machine-local parsing.

## Manual Chrome acceptance checklist

- [ ] Unpacked installation uses the correct folder and produces no manifest errors.
- [ ] Fresh and already-open portal tabs behave correctly after reload.
- [ ] Logged-out tabs, duplicate tabs, and absent tabs yield understandable errors.
- [ ] Delayed card insertion and attribute-only hydration produce a bounded response.
- [ ] Delayed data completes a pending request on either supported portal route.
- [ ] Other Turo pages never contribute records; prefetched future trips are excluded.
- [ ] Only the fixed detail endpoint for history-linked numeric reservation IDs is requested during sync, with no redirects or background polling.
- [ ] Actual detail JSON yields the correct epoch boundaries and vehicle ID; malformed, non-JSON, signed-out, and changed-schema responses fail safely.
- [ ] E-ZPass filters and manual tag entry are exercised against redacted fixtures.
- [ ] Wrong/unsupported schemas time out without overwriting saved data.
- [ ] Navigation, popup closure/reopening, extension reload, and worker suspension are exercised.
- [ ] Back/forward cache restoration reattaches capture correctly.
- [ ] Exact tag/plate mapping and overlapping trips are manually inspected.
- [ ] DST boundaries and end-point/grace cases match expected review behavior.
- [ ] Empty ranges, pagination, virtualized lists, and large responses are explicitly assessed.
- [ ] Clear data resets settings and reachable captures; unreachable-tab messaging is checked.
- [ ] No request credentials, raw response payloads, or private logs are persisted.

Record tested Chrome versions, portal paths, date ranges, redacted schema revision, and observed totals outside public personal-data fixtures. Do not mark an item complete based solely on mocked tests.

## Source control

Make focused changes, inspect the diff, and exclude account exports and local runtime data. Keep the root overview and extension documentation aligned with behavior. Preserve the existing MIT license and notices.

When working from a checkout:

```sh
git diff --check
git diff --stat
```

Commit tested changes with a descriptive message. Follow any repository branch protections and review policy; do not force-push over other contributors.

## Release readiness

The following are required work, not completed capabilities:

- [ ] Validate current authenticated Turo/E-ZPass schemas and status semantics.
- [ ] Establish stable source IDs and reliable deduplication.
- [ ] Verify loaded data against statement/trip totals and define completeness handling.
- [ ] Define account binding and safe behavior when switching accounts.
- [x] Support inclusive dated vehicle/transponder assignments and reject conflicting overlaps.
- [ ] Review money parsing, currency/units, credits, and source anomalies against verified fixtures.
- [ ] Establish privacy disclosure, consent, retention, and incident-reporting processes.
- [ ] Review applicable portal and distribution requirements.
- [ ] Test packaged installation and the supported browser/version matrix.
- [ ] Define support boundaries and a human approval process before billing use.
- [ ] Add store assets/versioning/release notes if pursuing a Chrome Web Store release.

For packaging, the selected archive's extension root must contain `manifest.json` and its referenced JS/HTML/CSS. Exclude Git history, private fixtures, and unrelated workspace folders. No packaging/upload automation is implemented here.

## Potential future work

The staged roadmap is maintained in the repository's `PROJECT_PLAN.md`. Candidate enhancements include screenshot evidence, account-scoped snapshots, retention enforcement, explicit pagination/completeness checks, an interval index for larger fleets, and reviewed invoice submission. These remain future milestones, not existing functionality.
