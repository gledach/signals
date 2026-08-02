// Chrome built-in AI helpers — Gemini Nano, runs locally, zero cost.
// Every function checks availability first and returns null if unsupported.

/** Check which AI features are available on this device */
export async function aiStatus() {
  const status = { summarizer: 'unavailable', prompt: 'unavailable', rewriter: 'unavailable' };
  try {
    if ('Summarizer' in self) status.summarizer = await Summarizer.availability();
  } catch {}
  try {
    if ('LanguageModel' in self) status.prompt = await LanguageModel.availability();
  } catch {}
  try {
    if ('Rewriter' in self) status.rewriter = await Rewriter.availability();
  } catch {}
  return status;
}

/** Returns true if any AI feature is usable */
export async function aiAvailable() {
  const s = await aiStatus();
  return Object.values(s).some(v => v === 'available' || v === 'downloadable' || v === 'readily');
}

/**
 * Summarize text using Chrome Summarizer API.
 * Returns summary string or null if unavailable.
 */
export async function summarizeText(text, type = 'tldr') {
  if (!('Summarizer' in self)) return null;
  const avail = await Summarizer.availability();
  if (avail === 'unavailable') return null;
  const summarizer = await Summarizer.create({ type, length: 'short', outputLanguage: 'en' });
  const result = await summarizer.summarize(text);
  summarizer.destroy();
  return result;
}

/**
 * Use Prompt API to classify a webpage — suggest companyId + signalType.
 * Returns { companyId, signalType, confidence } or null.
 */
export async function classifySignal(pageText, companies, signalTypes) {
  if (!('LanguageModel' in self)) return null;
  const avail = await LanguageModel.availability();
  if (avail === 'unavailable') return null;

  const companyList = companies.map(c => `${c.id} (${c.name})`).join(', ');
  const typeList = signalTypes.join(', ');

  const schema = {
    type: 'object',
    required: ['companyId', 'signalType', 'confidence'],
    additionalProperties: false,
    properties: {
      companyId: { type: 'string' },
      signalType: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 100 },
    },
  };

  const session = await LanguageModel.create({
    expectedInputLanguages: ['en'],
    expectedOutputLanguage: 'en',
    systemPrompt: `You are a competitive intelligence classifier. Given webpage text, identify which competitor it's about and the signal type.

Companies: ${companyList}

Signal types: ${typeList}

Return JSON with companyId, signalType, and confidence (0-100).
If you can't determine the competitor, use companyId "unknown".`,
  });

  try {
    const result = await session.prompt(
      `Classify this webpage:\n\n${pageText.slice(0, 4000)}`,
      { responseConstraint: schema },
    );
    return JSON.parse(result);
  } catch {
    return null;
  } finally {
    session.destroy();
  }
}

/**
 * Intel Check — compare page content against existing signals for a company.
 * Uses Prompt API (LanguageModel) to produce a structured analysis.
 *
 * @param {string}          pageText    — extracted page content
 * @param {string}          companyName — display name
 * @param {Array|string[]}  signalsOrDigest — either a signals array (legacy)
 *   or a pre-built digest string array from companies.json.  When the digest
 *   comes from the local file, each entry is already formatted as
 *   "[type] title (date)" so we just join them with "- " prefix.
 */
export async function intelCheck(pageText, companyName, signalsOrDigest) {
  if (!('LanguageModel' in self)) return null;
  const avail = await LanguageModel.availability();
  if (avail === 'unavailable') return null;

  let signalDigest;
  if (Array.isArray(signalsOrDigest) && signalsOrDigest.length > 0 && typeof signalsOrDigest[0] === 'string') {
    // Pre-built digest array from companies.json
    signalDigest = signalsOrDigest.map(d => `- ${d}`).join('\n');
  } else {
    // Raw signal objects — build digest on the fly
    const signals = signalsOrDigest || [];
    signalDigest = signals.slice(0, 30).map(s =>
      `- [${s.signalType}] ${s.title || s.summary || ''}`.slice(0, 150)
    ).join('\n');
  }

  const session = await LanguageModel.create({
    expectedInputLanguages: ['en'],
    expectedOutputLanguage: 'en',
    systemPrompt: `You are a competitive intelligence analyst. You will compare a webpage about "${companyName}" against existing intelligence signals we already have.

Your job:
1. Identify what on this page is NEW information we don't already have
2. Identify what we ALREADY KNEW from our signals
3. Assess the business impact (critical / high / medium / low / noise)
4. Recommend whether to clip this signal (yes / maybe / no)

Be concise and direct. No fluff. Use bullet points.`,
  });

  try {
    const result = await session.prompt(
      `EXISTING INTELLIGENCE ON ${companyName.toUpperCase()}:\n${signalDigest || '(no signals yet)'}\n\n---\n\nWEBPAGE CONTENT:\n${pageText.slice(0, 3500)}`
    );
    return result;
  } catch {
    return null;
  } finally {
    session.destroy();
  }
}

/**
 * Rewrite notes using Chrome Rewriter API.
 * style: 'more-concise' | 'more-formal' | 'as-is'
 */
export async function rewriteNotes(text, tone = 'more-concise') {
  if (!('Rewriter' in self)) return null;
  const avail = await Rewriter.availability();
  if (avail === 'unavailable') return null;
  const rewriter = await Rewriter.create({ tone });
  const result = await rewriter.rewrite(text);
  rewriter.destroy();
  return result;
}
