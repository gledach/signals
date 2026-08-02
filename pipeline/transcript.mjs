// YouTube transcript fetching.
// Tier 1 (default): YouTube captions via `youtube-transcript` — instant, free, zero deps.
// Tier 2 (opt-in):  Local Whisper via `nodejs-whisper` — when captions don't exist.
//
// Whisper opt-in:
//   1. npm install nodejs-whisper  (adds ~200MB: whisper.cpp binary + base.en model download)
//   1b. install yt-dlp and ffmpeg on PATH — audio download uses yt-dlp, not an npm library
//   2. set CI_WHISPER_ENABLED=true in .env
//   3. set CI_WHISPER_MODEL=base.en  (optional; default 'base.en'; alternatives: tiny.en, small.en, medium.en)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// `youtube-transcript` has a broken dual-package setup:
// package.json has "type": "module" AND main: CJS file, but no "exports" field,
// so neither `import ... from 'youtube-transcript'` nor `createRequire()` works.
// Work around by importing the ESM build file directly.
import { YoutubeTranscript } from 'youtube-transcript/dist/youtube-transcript.esm.js';
import { TRANSCRIPTS_DIR } from '../runtime/paths.mjs';

const TRANSCRIPT_ROOT = TRANSCRIPTS_DIR;

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
 * Fetch a video's audio as a WAV via yt-dlp.
 *
 * Fails with an actionable message rather than a stack trace when yt-dlp is absent —
 * "spawn yt-dlp ENOENT" tells an operator nothing about what to install.
 */
function downloadAudio(videoId, wavPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '--quiet', '--no-warnings', '--no-playlist',
      '-f', 'bestaudio',
      '-x', '--audio-format', 'wav',
      // whisper.cpp wants 16 kHz mono; converting here avoids a second pass.
      '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1',
      '-o', wavPath,
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(
          'yt-dlp is not installed. Whisper transcription downloads audio with it.\n'
          + '  pipx install yt-dlp   (or: brew install yt-dlp / winget install yt-dlp)\n'
          + 'It also needs ffmpeg on PATH. Leave CI_WHISPER_ENABLED unset to skip this path entirely.',
        ));
      } else reject(err);
    });
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(wavPath)) return resolve();
      reject(new Error(`yt-dlp exited ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`));
    });
  });
}

/**
 * Downloads audio from YouTube and runs whisper.cpp locally.
 * Uses a temp WAV file, cleaned up after transcription.
 *
 * AUDIO DOWNLOAD USES `yt-dlp`, NOT AN NPM LIBRARY.
 *
 * YouTube changes its player and signature scheme constantly, so a Node library that
 * reimplements the extraction breaks regularly and is fixed on its maintainer's
 * schedule. yt-dlp is the actively-maintained standard, updates within days, and is
 * invoked as a subprocess — so it costs this project zero npm dependencies and zero
 * supply-chain surface.
 *
 * It is NOT bundled: Whisper transcription is opt-in (`CI_WHISPER_ENABLED`), and
 * requiring a Python toolchain for a feature most users never turn on would break the
 * "clone and run" promise. Install it only if you enable Whisper:
 *
 *   pipx install yt-dlp        (or: brew install yt-dlp / winget install yt-dlp)
 */
async function transcribeViaWhisper(videoId) {
  const { nodewhisper } = await loadWhisper();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-whisper-'));
  const wavPath = path.join(tmpDir, `${videoId}.wav`);

  try {
    await downloadAudio(videoId, wavPath);

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
