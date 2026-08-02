#!/usr/bin/env node
// Quick ping of the classifier + synthesis models.
// Verifies OPENROUTER_API_KEY works, shows which slugs resolve (env overrides vs defaults),
// and prints round-trip latency for each.
//   node --env-file=.env check-models.mjs

import { chat, chatJson, classifierModel, synthesisModel, hasApiKey } from './openrouter.mjs';

if (!hasApiKey()) {
  console.error('✗ OPENROUTER_API_KEY not set — add it to .env and retry.');
  process.exit(2);
}

const PROBE = [{ role: 'user', content: 'Reply with the single word OK.' }];
const JSON_PROBE = [
  { role: 'system', content: 'Reply with strict JSON only.' },
  { role: 'user', content: 'Return {"status":"ok"} and nothing else.' },
];

async function ping(label, model, mode = 'text') {
  const t0 = Date.now();
  try {
    if (mode === 'json') {
      const j = await chatJson({ model, messages: JSON_PROBE, maxTokens: 50, temperature: 0 });
      const ms = Date.now() - t0;
      console.log(`✓ ${label.padEnd(11)} ${model.padEnd(42)} ${ms}ms   json=${JSON.stringify(j)}`);
    } else {
      const { content } = await chat({ model, messages: PROBE, maxTokens: 20, temperature: 0 });
      const ms = Date.now() - t0;
      const preview = content.replace(/\s+/g, ' ').slice(0, 60);
      console.log(`✓ ${label.padEnd(11)} ${model.padEnd(42)} ${ms}ms   "${preview}"`);
    }
    return true;
  } catch (err) {
    const ms = Date.now() - t0;
    console.error(`✗ ${label.padEnd(11)} ${model.padEnd(42)} ${ms}ms   ${err.message || err}`);
    return false;
  }
}

const classifier = classifierModel();
const synthesis = synthesisModel();

console.log('Probing OpenRouter…');
console.log(`  classifier: ${classifier}${process.env.CI_CLASSIFIER_MODEL ? ' (from env)' : ' (default)'}`);
console.log(`  synthesis : ${synthesis}${process.env.CI_SYNTHESIS_MODEL ? ' (from env)' : ' (default)'}`);
console.log('');

const results = await Promise.all([
  ping('classifier', classifier, 'json'),  // classifier uses json mode in the pipeline
  ping('synthesis',  synthesis,  'json'),  // synthesis also uses json mode in the pipeline
]);

const allOk = results.every(Boolean);
process.exit(allOk ? 0 : 1);
