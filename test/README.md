# `test/` — offline gates

Signal has **no CI** in the traditional sense. **`npm test` is the gate.**

```bash
npm test
# = smoke + fixture parsers (correlation, artifacts, mcp, github, reddit, email)
```

| Entry | Network? | DB write? | Spend? |
|---|---|---|---|
| [`smoke.mjs`](./smoke.mjs) (`npm run smoke`) | No | No | No |
| [`fixtures/*/parse-fixtures.mjs`](./fixtures/) | No | No | No |
| [`store-roundtrip.mjs`](./store-roundtrip.mjs) (`npm run db:test`) | Maybe | **Yes — configured Turso** | No |

**Never** run `db:test` against production without asking the human.

---

## Gmail fixtures

See [`fixtures/email/README.md`](./fixtures/email/README.md).

```bash
node test/fixtures/email/parse-fixtures.mjs
```

Covers: sanitiser, Google Alerts parser, trusted-From registry, Zone 1/2 import walls, MCP no-gmail invariant.

---

## Adding a fixture suite

1. `test/fixtures/<name>/` with sample payloads + `parse-fixtures.mjs`
2. Append to `"test"` script in `package.json`
3. Keep it offline and side-effect free (do not import watchers that auto-run `main()` without a guard)
