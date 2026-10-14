// LLM wrapper over the Workers AI binding, plus tolerant JSON parsing.
// The LLM never sees the Qloo key and never invents acts: its outputs are validated
// against the Qloo candidate set by the agent.
import { MODEL, LLM } from './config.js';
import { mockComplete } from './mock/llm-mock.js';

export function llmMode(env) {
  if (env && env.LINEUPLAB_MOCK === '1') return 'mock';
  return env && env.AI && typeof env.AI.run === 'function' ? 'live' : 'mock';
}

// Pull a JSON object/array out of model text: code fences, leading prose, trailing commas,
// smart quotes. Returns null when nothing parseable is found (callers fall back).
export function parseJsonLoose(input) {
  if (input == null) return null;
  if (typeof input === 'object') return input;
  let s = String(input).trim();
  if (!s) return null;
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const tryParse = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  let v = tryParse(s);
  if (v !== undefined && typeof v === 'object') return v;
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const chunk = balanced(s, start);
  if (!chunk) return null;
  v = tryParse(chunk);
  if (v !== undefined) return v;
  const repaired = chunk
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
  v = tryParse(repaired);
  return v === undefined ? null : v;
}

// Return the substring from `start` to its matching close bracket (string-aware).
function balanced(s, start) {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// demoFallback: when the whole run is already on synthetic Qloo fixtures, a failing AI
// binding (e.g. `wrangler dev --local`, where Workers AI is "not supported") switches to
// the deterministic mock model for the rest of the run instead of degrading every step.
// With live Qloo data it stays off: templated fallbacks are used and the trace says so.
export function createLLM({ env = {}, onCall, demoFallback = false } = {}) {
  let mode = llmMode(env);
  let calls = 0;
  let degradedReason = null;
  return {
    get mode() {
      return mode;
    },
    get degradedReason() {
      return degradedReason;
    },
    model: MODEL,
    get calls() {
      return calls;
    },
    // Returns { data, raw, ms, ok }. `data` is the parsed JSON or null.
    async json({ task, system, user, context, maxTokens = 900 }) {
      calls++;
      const started = Date.now();
      let raw = '';
      let error = null;
      try {
        if (mode === 'mock') {
          raw = await mockComplete(task, context);
        } else {
          const run = env.AI.run(MODEL, {
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            max_tokens: maxTokens,
            temperature: LLM.temperature,
          });
          const out = await Promise.race([
            run,
            new Promise((_, rej) => setTimeout(() => rej(new Error('LLM timeout')), LLM.timeoutMs)),
          ]);
          raw = out && typeof out.response === 'object' ? out.response : out?.response ?? out?.result?.response ?? '';
        }
      } catch (err) {
        error = err && err.message ? String(err.message).slice(0, 120) : 'LLM error';
        if (demoFallback) {
          mode = 'mock';
          degradedReason = error;
          raw = await mockComplete(task, context);
          error = null;
        }
      }
      const data = error ? null : parseJsonLoose(raw);
      const ms = Date.now() - started;
      onCall?.({ task, ok: !!data, ms, error });
      return { data, raw, ms, ok: !!data, error };
    },
  };
}
