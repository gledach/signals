// YouTube transcript fetching.
// Tier 1 (default): YouTube captions via `youtube-transcript` — instant, free, zero deps.
// Tier 2 (opt-in):  Local Whisper via `nodejs-whisper` — when captions don't exist.
//
// Whisper opt-in:
//   1. npm install nodejs-whisper  (adds ~200MB: whisper.cpp binary + base.en model download)
//   2. set CI_WHISPER_ENABLED=true in .env
//   3. set CI_WHISPER_MODEL=base.en  (optional; default 'base.en'; alternatives: tiny.en, small.en, medium.en)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// `youtube-transcript` has a broken dual-package setup:
// package.json has "type": "module" AND main: CJS file, but no "exports" field,
// so neither `import ... from 'youtube-transcript'` nor `createRequire()` works.
// Work around by importing the ESM build file directly.
import { YoutubeTranscript } from 'youtube-transcript/dist/youtube-transcript.esm.js';
import { TRANSCRIPTS_DIR } from '../runtime/paths.mjs';

const __dirname_t = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPT_ROOT = TRANSCRIPTS_DIR;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} videoId   — YouTube video ID (11 chars, e.g. "dQw4w9WgXcQ")
 * @returns {Promise<{text: string, source: 'captions'|'whisper', lang?: string} | null>}
 *   Returns null if no transcript is obtainable.
 */
export async function getTranscript(videoId) {
  // 1. Captions path
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
    if (segments?.length) {
      const text = segments.map((s) => s.text).join(' ').trim();
      if (text.length > 40) {
        return { text, source: 'captions', lang: 'en' };
      }
    }
  } catch (err) {
    // youtube-transcript throws "Transcript is disabled on this video" etc. — fall through.
  }

  // 2. Whisper path (opt-in)
  if (process.env.CI_WHISPER_ENABLED === 'true') {
    try {
      return await transcribeViaWhisper(videoId);
    } catch (err) {
      console.warn(`[transcript] whisper failed for ${videoId}: ${err?.message || err}`);
      return null;
    }
  }

  return null;
}

// ─────────────────────────────── Whisper (opt-in) ───────────────────────────

let _whisperModule = null;

async function loadWhisper() {
  if (_whisperModule) return _whisperModule;
  try {
    _whisperModule = await import('nodejs-whisper');
    return _whisperModule;
  } catch (err) {
    throw new Error('nodejs-whisper not installed — run: npm install nodejs-whisper');
  }
}

/**
 * Downloads audio from YouTube and runs whisper.cpp locally.
 * Uses a temp WAV file; cleaned up after transcription.
 * NOTE: audio download currently requires `@distube/ytdl-core` which is NOT pre-installed —
 *       add it when you first enable whisper: npm install @distube/ytdl-core
 */
async function transcribeViaWhisper(videoId) {
  // Lazy-import ytdl-core so users who never enable Whisper don't pay the dep cost.
  let ytdl;
  try {
    ytdl = (await import('@distube/ytdl-core')).default;
  } catch {
    throw new Error('@distube/ytdl-core not installed — run: npm install @distube/ytdl-core');
  }

  const { nodewhisper } = await loadWhisper();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-whisper-'));
  const wavPath = path.join(tmpDir, `${videoId}.wav`);

  try {
    // Download audio as WAV
    await new Promise((resolve, reject) => {
      const stream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
        filter: 'audioonly',
        quality: 'lowestaudio',
      });
      const out = fs.createWriteStream(wavPath);
      stream.pipe(out);
      stream.on('error', reject);
      out.on('finish', resolve);
      out.on('error', reject);
    });

    const model = process.env.CI_WHISPER_MODEL || 'base.en';
    const result = await nodewhisper(wavPath, {
      modelName: model,
      autoDownloadModelName: model,
      removeWavFileAfterTranscription: false,
      verbose: false,
      withCuda: false,
      whisperOptions: {
        outputInText: true,
        outputInSrt: false,
        outputInVtt: false,
        translateToEnglish: false,
        language: 'en',
      },
    });

    const text = typeof result === 'string' ? result : (result?.transcription || '');
    return text.trim() ? { text: text.trim(), source: 'whisper', lang: 'en' } : null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ─────────────────────────────── helpers ────────────────────────────────────

/**
 * Extract a YouTube video ID from an RSS `<id>` field like
 *   "yt:video:dQw4w9WgXcQ"   or a URL   "https://www.youtube.com/watch?v=dQw4w9WgXcQ".
 */
export function extractVideoId(str) {
  if (!str) return null;
  const ytId = str.match(/yt:video:([\w-]{11})/);
  if (ytId) return ytId[1];
  const urlV = str.match(/[?&]v=([\w-]{11})/);
  if (urlV) return urlV[1];
  const shortY = str.match(/youtu\.be\/([\w-]{11})/);
  if (shortY) return shortY[1];
  if (/^[\w-]{11}$/.test(str)) return str;
  return null;
}

// ─────────────────────────────── disk archive ──────────────────────────────

export function transcriptPath(companyId, videoId) {
  return path.join(TRANSCRIPT_ROOT, companyId, `${videoId}.json`);
}

export function hasTranscript(companyId, videoId) {
  return fs.existsSync(transcriptPath(companyId, videoId));
}

/**
 * Save a transcript to `data/transcripts/<companyId>/<videoId>.json`.
 * Payload is the raw transcript + useful metadata (title, channel, source, lang, fetchedAt).
 * No-op if file already exists unless `overwrite: true`.
 */
/**
 * How much transcript text is retained.
 *
 * We used to store the full caption track — the entire work — which is the largest
 * copyright and terms-of-service exposure in the codebase, and it bought nothing:
 * `truncateForClassifier()` proves the pipeline never reads beyond ~6k characters.
 *
 * What is kept is an excerpt for classification plus a permanent link back to the
 * source, which is the shape of a citation rather than an archive. Raise this only with
 * a reason better than "it might be useful later".
 */
export const RETAINED_CHARS = 6000;

export function saveTranscript(companyId, videoId, { title, channelId, source, lang, text, extra }, { overwrite = false } = {}) {
  const file = transcriptPath(companyId, videoId);
  if (!overwrite && fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const full = text || '';
  const excerpt = truncateForClassifier(full, RETAINED_CHARS);

  const payload = {
    videoId,
    companyId,
    channelId: channelId || null,
    title: title || '',
    source: source || 'unknown',
    lang: lang || null,
    fetchedAt: new Date().toISOString(),
    // The original length is kept so the excerpt is never mistaken for the whole thing.
    originalCharCount: full.length,
    charCount: excerpt.length,
    truncated: excerpt.length < full.length,
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    excerpt,
    ...(extra || {}),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return true;
}

/**
 * Load a previously saved transcript. Returns null if not present or unreadable.
 */
export function loadTranscript(companyId, videoId) {
  const file = transcriptPath(companyId, videoId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ─────────────────────────────── helpers ────────────────────────────────────

export function truncateForClassifier(text, maxChars = 6000) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  // Take first ~70% + last ~30% — captures intro + conclusion.
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return text.slice(0, head) + '\n\n[…transcript truncated…]\n\n' + text.slice(-tail);
}
