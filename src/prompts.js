// Prompt builders. Every LLM step asks for JSON only; the agent parses tolerantly and has a
// deterministic fallback for each step, so a malformed answer degrades, never breaks.
import { AGE_BANDS } from './config.js';

const JSON_ONLY = 'Respond with a single JSON object and nothing else. No markdown, no commentary.';

export function venueSummary(v) {
  const lines = [
    `Venue: ${v.venueName || 'an independent venue'} in ${v.location}.`,
    `Capacity: ${v.tier.label} people.`,
    `Main crowd age: ${AGE_BANDS[v.age] || 'mixed'}.`,
  ];
  if (v.genres) lines.push(`Genres / vibe: ${v.genres}.`);
  if (v.pastActs.length) lines.push(`Acts that drew well before: ${v.pastActs.join(', ')}.`);
  lines.push(`Dates to fill: ${v.dates}.`);
  return lines.join('\n');
}

export function planPrompt(v) {
  return {
    system:
      'You convert a small music venue\'s brief into inputs for the Qloo taste API. ' +
      'location_query: the neighbourhood and city as a geocoder would understand it (e.g. "Wicker Park, Chicago"); keep the user\'s place, only clean it up. ' +
      'keywords: up to 4 short music genre or scene words that capture the stated vibe (e.g. "shoegaze", "neo soul"); use [] if no vibe was given; never invent artists. ' +
      'audience_note: one short sentence describing the crowd. ' +
      JSON_ONLY +
      ' Shape: {"location_query":"...","keywords":["..."],"audience_note":"..."}',
    user: venueSummary(v),
  };
}

export function lineupPrompt(v, candidates, dates) {
  const rows = candidates
    .map(
      (c) =>
        `- ${c.name} | affinity ${fmt(c.affinity)} | popularity ${fmt(c.popularity)} (${c.popularity_band}) | ${c.local.text} | trend ${c.trend.label}` +
        (c.tags.length ? ` | ${c.tags.slice(0, 3).join(', ')}` : ''),
    )
    .join('\n');
  return {
    system:
      'You are LineupLab, a talent buyer for small independent venues. Build a lineup ONLY from the candidate list, which comes from Qloo taste data for this neighbourhood and audience. ' +
      'Never use an act that is not in the list, never repeat an act. Each date has one headliner and one support; the headliner should usually have the higher popularity, the support should share some taste with the headliner. ' +
      'Spread genres across dates when the list allows it. Reasons must cite the numbers given (affinity, popularity, local rank, trend) and be at most 25 words. ' +
      JSON_ONLY +
      ' Shape: {"dates":[{"headliner":"<exact name>","support":"<exact name>","theme":"<3-6 words>","why_headliner":"...","why_support":"..."}]}',
    user: `${venueSummary(v)}\n\nPopularity ceiling for this room: ${v.tier.popMax}.\nCandidates from Qloo (best affinity first):\n${rows}\n\nReturn exactly ${dates} dates.`,
  };
}

export function copyPrompt(v, lineup, places, brands, keywords) {
  const dates = lineup.map((d) => `Date ${d.date}: ${d.headliner.name} with ${d.support.name}${d.theme ? ` ("${d.theme}")` : ''}`).join('\n');
  const pl = places.map((p) => `- ${p.name}${p.category ? ` (${p.category})` : ''}, affinity ${fmt(p.affinity)}`).join('\n') || '- none';
  const br = brands.map((b) => `- ${b.name}${b.category ? ` (${b.category})` : ''}, affinity ${fmt(b.affinity)}`).join('\n') || '- none';
  return {
    system:
      'You write practical marketing for a small venue. Partnership ideas: one concrete, low-cost co-promotion per partner (at most 22 words), using the partner\'s category. ' +
      'Blurbs: one ready-to-post announcement per date, at most 60 words, written for fans whose tastes include the listed places and brands (refer to them as the kind of place, or by name). ' +
      'Do not invent facts about the acts (no hometowns, awards, albums, prices or calendar dates); say "Date 1" style if needed. ' +
      JSON_ONLY +
      ' Shape: {"partnerships":[{"name":"<exact partner name>","idea":"..."}],"blurbs":[{"date":1,"text":"..."}]}',
    user: `${venueSummary(v)}\nVibe keywords: ${keywords.join(', ') || 'none given'}\n\nLineup:\n${dates}\n\nNearby places these fans over-index on:\n${pl}\n\nBrands these fans over-index on:\n${br}`,
  };
}

export function baselinePrompt(v) {
  return {
    system:
      'You are a talent buyer. Suggest a lineup for the venue below from your own knowledge. One headliner and one support per date, with a one-line reason each. ' +
      JSON_ONLY +
      ' Shape: {"dates":[{"headliner":"...","support":"...","reason":"..."}]}',
    user: venueSummary(v),
  };
}

function fmt(n) {
  return typeof n === 'number' ? n.toFixed(2) : 'n/a';
}
