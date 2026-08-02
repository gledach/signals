#!/usr/bin/env node
// Behavioural tests for the artifact layer, run against a THROWAWAY local database.
// No hosted database, no network, no LLM.
//   node test/fixtures/artifacts/parse-fixtures.mjs
//
// The case that matters is the last one: a rep's captured kill shot landing while an LLM
// regeneration is in flight. Getting that wrong destroys the most valuable human-written
// content in the system, and it is invisible until someone goes looking for a kill shot
// that is no longer there.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point at a scratch database BEFORE anything imports the store.
const tmpDb = path.join(os.tmpdir(), `signal-artifacts-${process.pid}.db`);
process.env.TURSO_DATABASE_URL = `file:${tmpDb.replace(/\\/g, '/')}`;
delete process.env.TURSO_AUTH_TOKEN;

const { ROOT, BATTLECARDS_DIR, TALK_TRACKS_DIR } = await import('../../../runtime/paths.mjs');
const {
  readArtifact, writeArtifact, updateArtifact, updateAutoSection, spliceAutoSection,
  readJsonArtifact, writeJsonArtifact, listJsonArtifacts, removeArtifact,
  AUTO_START, AUTO_END,
} = await import('../../../core/artifacts.mjs');

// Apply the schema to the scratch database.
const { execSync } = await import('node:child_process');
execSync(`node "${path.join(ROOT, 'ops', 'db-migrate.mjs')}"`, {
  env: { ...process.env, SIGNALS_NO_DEMO_SEED: '1' },
  stdio: 'ignore',
});

let fails = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.log(`  FAIL ${label}`); fails++; }
};

const KEY = `__test-card-${process.pid}`;
const cardFile = path.join(BATTLECARDS_DIR, `${KEY}.md`);

try {
  // ── round trip ────────────────────────────────────────────────────────────
  console.log('\nread / write');
  {
    const empty = await readArtifact('battlecard', KEY);
    ok(empty.body === '' && empty.source === null, 'absent artifact reads as empty, not an error');

    await writeArtifact({ kind: 'battlecard', artifactKey: KEY, companyId: 'acme', body: '# hello' });
    const back = await readArtifact('battlecard', KEY);
    ok(back.body === '# hello', 'round-trips through the database');
    ok(back.source === 'db', 'read prefers the database');
    ok(fs.existsSync(cardFile), 'mirrored to disk');
    ok(fs.readFileSync(cardFile, 'utf8') === '# hello', 'disk mirror matches');
  }

  // ── disk fallback ─────────────────────────────────────────────────────────
  console.log('\ndisk fallback');
  {
    const orphanKey = `__test-orphan-${process.pid}`;
    const orphanFile = path.join(BATTLECARDS_DIR, `${orphanKey}.md`);
    fs.writeFileSync(orphanFile, '# only on disk');
    const r = await readArtifact('battlecard', orphanKey);
    ok(r.body === '# only on disk' && r.source === 'disk', 'falls back to disk when no row exists');
    fs.rmSync(orphanFile, { force: true });
  }

  // ── AUTO / HUMAN splice ───────────────────────────────────────────────────
  console.log('\nAUTO section splice');
  {
    ok(spliceAutoSection('no markers here', 'x') === null, 'missing markers → null, not a silent overwrite');
    const doc = `# Card\n\n## HUMAN\nkeep me\n\n${AUTO_START}\nold auto\n${AUTO_END}\n`;
    const out = spliceAutoSection(doc, 'new auto');
    ok(out.includes('keep me'), 'human content preserved');
    ok(out.includes('new auto') && !out.includes('old auto'), 'auto content replaced');
  }

  // ── THE HAZARD ────────────────────────────────────────────────────────────
  // A regeneration reads the card, spends ten minutes in an LLM, and writes back. A rep
  // captures a kill shot during that window. The naive implementation holds a stale copy
  // in memory and overwrites the capture.
  console.log('\nconcurrent capture during a slow regeneration');
  {
    await writeArtifact({
      kind: 'battlecard', artifactKey: KEY, companyId: 'acme',
      body: `# Card\n\n## Kill shots\n- original\n\n${AUTO_START}\nauto v1\n${AUTO_END}\n`,
    });

    // The regeneration begins and reads the card.
    const snapshotAtStart = (await readArtifact('battlecard', KEY)).body;
    ok(snapshotAtStart.includes('auto v1'), 'regeneration read the starting state');

    // MEANWHILE: a rep captures a kill shot.
    await updateArtifact({ kind: 'battlecard', artifactKey: KEY, companyId: 'acme' },
      (current) => current.replace('- original', '- original\n- CAPTURED MID-FLIGHT'));

    // The regeneration finishes and writes its AUTO section.
    await updateAutoSection({ kind: 'battlecard', artifactKey: KEY, companyId: 'acme' },
      { autoBody: 'auto v2' });

    const final = (await readArtifact('battlecard', KEY)).body;
    ok(final.includes('CAPTURED MID-FLIGHT'), 'the mid-flight capture SURVIVED');
    ok(final.includes('- original'), 'pre-existing human content survived');
    ok(final.includes('auto v2'), 'the regenerated auto section landed');
    ok(!final.includes('auto v1'), 'the stale auto section is gone');

    const onDisk = fs.readFileSync(cardFile, 'utf8');
    ok(onDisk === final, 'disk mirror agrees with the database');
  }

  // ── JSON artifacts (talk tracks) ──────────────────────────────────────────
  console.log('\nJSON artifacts');
  {
    const key = `acme/${`prep-${process.pid}`}`;
    ok(await readJsonArtifact('talktrack', key) === null, 'absent JSON artifact reads as null');

    await writeJsonArtifact({
      kind: 'talktrack', artifactKey: key, companyId: 'acme',
      value: { id: 'prep', competitorId: 'acme', savedAt: '2026-08-02T00:00:00Z' },
    });
    const back = await readJsonArtifact('talktrack', key);
    ok(back?.competitorId === 'acme', 'JSON round-trips through the database');

    const listed = await listJsonArtifacts('talktrack', { companyId: 'acme' });
    ok(listed.some((r) => r._key === key), 'appears in the listing');
    ok(listed.find((r) => r._key === key)?._source === 'db', 'listing reports the database as the source');

    const { deleted } = await removeArtifact('talktrack', key);
    ok(deleted >= 1, 'delete reports what it removed');
    ok(await readJsonArtifact('talktrack', key) === null, 'gone after delete');
    ok((await removeArtifact('talktrack', key)).deleted === 0, 'deleting twice is not an error');
  }

  // ── records written before adoption stay visible ──────────────────────────
  // Dropping pre-existing files silently would be the same class of data loss this
  // layer exists to prevent, just quieter.
  console.log('\nlegacy disk records');
  {
    const legacyKey = `acme/legacy-${process.pid}`;
    const legacyFile = path.join(TALK_TRACKS_DIR, `${legacyKey}.json`);
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({ id: 'legacy', competitorId: 'acme', savedAt: '2026-01-01T00:00:00Z' }));

    const listed = await listJsonArtifacts('talktrack', { companyId: 'acme' });
    const found = listed.find((r) => r._key === legacyKey);
    ok(!!found, 'a file written before adoption still appears');
    ok(found?._source === 'disk', 'and is reported as coming from disk');

    await removeArtifact('talktrack', legacyKey);
    ok(!fs.existsSync(legacyFile), 'delete removes the disk mirror too');
  }

  // ── creation from nothing ─────────────────────────────────────────────────
  console.log('\nfirst generation');
  {
    const freshKey = `__test-fresh-${process.pid}`;
    await updateAutoSection({ kind: 'battlecard', artifactKey: freshKey, companyId: 'acme' },
      { autoBody: 'generated', renderFull: (auto) => `# New Card\n\n${AUTO_START}\n${auto}\n${AUTO_END}\n` });
    const r = await readArtifact('battlecard', freshKey);
    ok(r.body.includes('# New Card') && r.body.includes('generated'), 'renders a full document when none exists');
    fs.rmSync(path.join(BATTLECARDS_DIR, `${freshKey}.md`), { force: true });
  }
} finally {
  // Best-effort cleanup. The libSQL client keeps the file open and Windows refuses to
  // unlink it, so a failure here must not mask the test result — it is a temp file.
  const tryRm = (p) => { try { fs.rmSync(p, { force: true }); } catch { /* leave it for the OS */ } };
  tryRm(cardFile);
  for (const suffix of ['', '-shm', '-wal']) tryRm(tmpDb + suffix);
}

console.log(fails ? `\nRED  ${fails} assertion(s) failed\n` : '\nGREEN  artifact fixtures\n');
process.exit(fails ? 1 : 0);
