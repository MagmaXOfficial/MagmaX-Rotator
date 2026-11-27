import type { SkillManifest } from '../types.js';

export interface BuiltinSkill {
  manifest: SkillManifest;
  entrySource: string;
}

const summarizerEntry = `// Extractive summarizer — deterministic, no external calls.
function splitSentences(text) {
  return text
    .replace(/\\s+/g, ' ')
    .split(/(?<=[.!?])\\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function run(input) {
  const text = String(input.text ?? '');
  if (!text.trim()) return { summary: '', sentences: 0, note: 'No text supplied' };
  const sentences = splitSentences(text);
  const target = Math.max(1, Math.min(Number(input.sentences) || 5, 40));
  if (sentences.length <= target) return { summary: sentences.join(' '), sentences: sentences.length, selected: sentences.length };

  const freq = new Map();
  for (const word of text.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }
  const scored = sentences.map((sentence, index) => {
    const words = sentence.toLowerCase().match(/[a-z0-9']{3,}/g) ?? [];
    const score = words.reduce((sum, w) => sum + (freq.get(w) ?? 0), 0) / Math.max(1, words.length);
    return { sentence, index, score: score + (index === 0 ? 2 : 0) };
  });
  const chosen = scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, target)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.sentence);
  return {
    summary: chosen.join(' '),
    sentences: sentences.length,
    selected: chosen.length,
    reduction: Math.round((1 - chosen.join(' ').length / text.length) * 100),
  };
}
`;

const jsonToolkitEntry = `// JSON validation, formatting and conservative repair.
function stripFences(value) {
  return value.trim().replace(/^\\u0060\\u0060\\u0060(?:json)?/i, '').replace(/\\u0060\\u0060\\u0060$/, '').trim();
}

function repair(raw) {
  let text = stripFences(raw)
    .replace(/,\\s*([}\\]])/g, '$1')
    .replace(/([{,])\\s*([A-Za-z_$][\\w$]*)\\s*:/g, '$1"$2":')
    .replace(/'([^'\\\\]*)'/g, '"$1"');
  const first = Math.min(...[text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0));
  if (Number.isFinite(first)) {
    const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (lastBrace > first) text = text.slice(first, lastBrace + 1);
  }
  return JSON.parse(text);
}

export async function run(input) {
  const action = String(input.action ?? 'format');
  const raw = String(input.json ?? input.text ?? '');
  if (!raw.trim()) throw new Error('Input JSON is empty');
  if (action === 'validate') {
    try {
      const value = JSON.parse(raw);
      return { valid: true, type: Array.isArray(value) ? 'array' : typeof value, keys: value && !Array.isArray(value) ? Object.keys(value).length : undefined };
    } catch (err) {
      return { valid: false, error: String(err.message ?? err) };
    }
  }
  if (action === 'minify') return { result: JSON.stringify(JSON.parse(raw)) };
  if (action === 'repair') {
    const value = repair(raw);
    return { result: JSON.stringify(value, null, 2), repaired: true };
  }
  const value = JSON.parse(raw);
  return { result: JSON.stringify(value, null, Number(input.indent) || 2) };
}
`;

const tokenEstimatorEntry = `// Token and cost estimation. Clearly labelled as an estimate.
export async function run(input) {
  const text = String(input.text ?? '');
  const tokens = Math.max(1, Math.ceil(text.length / 4));
  const words = (text.match(/\\S+/g) ?? []).length;
  const inputPrice = Number(input.inputPricePerMillion);
  const outputTokens = Math.max(0, Number(input.outputTokens) || 0);
  const outputPrice = Number(input.outputPricePerMillion);
  const result = {
    characters: text.length,
    words,
    estimatedTokens: tokens,
    method: '≈4 characters per token (heuristic, not a tokenizer)',
  };
  if (Number.isFinite(inputPrice) && inputPrice >= 0) {
    result.estimatedInputCostUsd = Math.round((tokens / 1e6) * inputPrice * 1e6) / 1e6;
    if (Number.isFinite(outputPrice) && outputTokens > 0) {
      result.estimatedOutputCostUsd = Math.round((outputTokens / 1e6) * outputPrice * 1e6) / 1e6;
      result.estimatedTotalCostUsd = result.estimatedInputCostUsd + result.estimatedOutputCostUsd;
    }
  }
  return result;
}
`;

const regexTesterEntry = `// Regex testing with match limits.
export async function run(input) {
  const pattern = String(input.pattern ?? '');
  if (!pattern) throw new Error('pattern is required');
  if (pattern.length > 500) throw new Error('pattern is limited to 500 characters');
  const flags = String(input.flags ?? 'g').replace(/[gy]/g, '') + 'g';
  const text = String(input.text ?? '');
  if (text.length > 200000) throw new Error('text is limited to 200000 characters');
  const regex = new RegExp(pattern, flags);
  const matches = [];
  let match;
  let guard = 0;
  while ((match = regex.exec(text)) !== null && guard < 200) {
    matches.push({ match: match[0], index: match.index, groups: match.slice(1) });
    if (match[0] === '') regex.lastIndex++;
    guard++;
  }
  return { count: matches.length, truncated: guard >= 200, matches };
}
`;

const urlMetadataEntry = `// Fetches a URL and extracts metadata. Requires the network permission.
export async function run(input) {
  const url = String(input.url ?? '');
  if (!/^https?:\\/\\//i.test(url)) throw new Error('Only http(s) URLs are allowed');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'MagmaX-Rotator-Skill/1.0' } });
    const html = (await response.text()).slice(0, 400000);
    const title = /<title[^>]*>([\\s\\S]*?)<\\/title>/i.exec(html)?.[1]?.trim() ?? null;
    const description = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ?? null;
    const links = (html.match(/<a\\s/gi) ?? []).length;
    return { status: response.status, title, description, links, bytes: html.length };
  } finally {
    clearTimeout(timer);
  }
}
`;

const lineDiffEntry = `// Line diff summary (LCS) with a size guard.
function lcs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

export async function run(input) {
  const before = String(input.before ?? '').split(/\\r?\\n/);
  const after = String(input.after ?? '').split(/\\r?\\n/);
  if (before.length * after.length > 4_000_000) throw new Error('Inputs are too large for the diff skill (line product limit)');
  const dp = lcs(before, after);
  const ops = [];
  let i = before.length;
  let j = after.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && before[i - 1] === after[j - 1]) {
      ops.push({ type: 'context', line: before[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'added', line: after[j - 1] });
      j--;
    } else if (i > 0) {
      ops.push({ type: 'removed', line: before[i - 1] });
      i--;
    }
  }
  ops.reverse();
  const added = ops.filter((o) => o.type === 'added').length;
  const removed = ops.filter((o) => o.type === 'removed').length;
  return { added, removed, unchanged: ops.filter((o) => o.type === 'context').length, ops: ops.slice(0, 200) };
}
`;

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    manifest: {
      id: 'text-summarizer',
      name: 'Text Summarizer',
      version: '1.0.0',
      description: 'Deterministic extractive summarizer. Scores sentences by word frequency — no model calls.',
      entry: 'index.mjs',
      runtime: 'node',
      permissions: { network: [], filesystem: 'none', env: [] },
      tags: ['text', 'local'],
      timeoutMs: 10000,
      exampleInput: { text: 'MagmaX Rotator unifies AI providers behind one API. It fails over automatically when a model is rate limited. Every request is monitored. Configuration stays local.', sentences: 2 },
    },
    entrySource: summarizerEntry,
  },
  {
    manifest: {
      id: 'json-toolkit',
      name: 'JSON Toolkit',
      version: '1.0.0',
      description: 'Validate, format, minify and conservatively repair JSON payloads.',
      entry: 'index.mjs',
      runtime: 'node',
      permissions: { network: [], filesystem: 'none', env: [] },
      tags: ['json', 'developer'],
      timeoutMs: 8000,
      exampleInput: { action: 'repair', json: '{"model":"magma","providers":["nvidia","groq"],}' },
    },
    entrySource: jsonToolkitEntry,
  },
  {
    manifest: {
      id: 'token-estimator',
      name: 'Token & Cost Estimator',
      version: '1.0.0',
      description: 'Estimates token counts and cost from your prompt using a 4-chars/token heuristic.',
      entry: 'index.mjs',
      runtime: 'node',
      permissions: { network: [], filesystem: 'none', env: [] },
      tags: ['tokens', 'cost'],
      timeoutMs: 5000,
      exampleInput: { text: 'Explain the failover engine in three bullet points.', inputPricePerMillion: 0.6, outputTokens: 300, outputPricePerMillion: 2.4 },
    },
    entrySource: tokenEstimatorEntry,
  },
  {
    manifest: {
      id: 'regex-tester',
      name: 'Regex Tester',
      version: '1.0.0',
      description: 'Runs a JavaScript regular expression against text with match limits.',
      entry: 'index.mjs',
      runtime: 'node',
      permissions: { network: [], filesystem: 'none', env: [] },
      tags: ['developer', 'regex'],
      timeoutMs: 5000,
      exampleInput: { pattern: '(\\w+)@(\\w+\\.\\w+)', text: 'ops@magmax.dev and dev@example.com' },
    },
    entrySource: regexTesterEntry,
  },
  {
    manifest: {
      id: 'url-metadata',
      name: 'URL Metadata',
      version: '1.0.0',
      description: 'Fetches a page and extracts its title, description and link count. Requires network permission.',
      entry: 'index.mjs',
      runtime: 'node',
      permissions: { network: ['https://*'], filesystem: 'none', env: [] },
      tags: ['network', 'research'],
      timeoutMs: 15000,
      exampleInput: { url: 'https://example.com' },
    },
    entrySource: urlMetadataEntry,
  },
  {
    manifest: {
      id: 'line-diff',
      name: 'Line Diff',
      version: '1.0.0',
      description: 'Line-level diff between two texts with added/removed counts.',
      entry: 'index.mjs',
      runtime: 'node',
      permissions: { network: [], filesystem: 'none', env: [] },
      tags: ['developer', 'text'],
      timeoutMs: 8000,
      exampleInput: { before: 'model: nvidia\nfallback: true\nretries: 3', after: 'model: groq\nfallback: true\nretries: 5' },
    },
    entrySource: lineDiffEntry,
  },
];
