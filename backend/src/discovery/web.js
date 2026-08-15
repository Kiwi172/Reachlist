import axios from 'axios';
import { toDomain, isLikelyBusinessDomain } from '../lib/url.js';

const KEY = process.env.BRAVE_SEARCH_API_KEY;

export const isConfigured = () => Boolean(KEY);

// Serialised with a deliberate gap rather than fanned out. The per-second
// ceiling is generous now, but the monthly query budget is small and
// metered, so pacing keeps a runaway campaign from burning it in one pass.
// A discovery run is not latency-sensitive either way.
const QUERY_GAP_MS = 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Discovery for online-first businesses, driven by the AI's search queries.
 *
 * Result quality is materially worse than Places: search engines return
 * listicles and directories for commercial-intent queries, so aggregators
 * are filtered out and each remaining domain is kept only once.
 */
export async function search({ criteria, limitPerQuery = 20 }) {
  const out = [];
  const seen = new Set();

  // Pair each query with each location so the geography actually constrains
  // results — Brave has no structured location filter on the free tier.
  const queries = [];
  for (const q of criteria.searchQueries) {
    if (criteria.locations.length) {
      for (const loc of criteria.locations) queries.push(`${q} ${loc.label}`);
    } else {
      queries.push(q);
    }
  }

  for (const [i, q] of queries.entries()) {
    if (i > 0) await sleep(QUERY_GAP_MS);

    let res;
    try {
      res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
        params: { q, count: Math.min(limitPerQuery, 20) },
        headers: { Accept: 'application/json', 'X-Subscription-Token': KEY },
        timeout: 20_000,
      });
    } catch (err) {
      if (err.response?.status === 429) {
        out.push({ __error: 'Brave Search rate limit hit — remaining queries skipped.' });
        break;
      }
      out.push({ __error: `Search for "${q}" failed: ${err.message}` });
      continue;
    }

    for (const r of res.data?.web?.results || []) {
      const domain = toDomain(r.url);
      if (!domain || seen.has(domain) || !isLikelyBusinessDomain(domain)) continue;
      seen.add(domain);

      out.push({
        // Search titles carry " | Home", " - Official Site" etc. Trimming at
        // the first separator gets close to the actual business name.
        name: (r.title || domain).split(/\s[|–—-]\s/)[0].trim().slice(0, 200),
        websiteUrl: r.url,
        domain,
        phone: null,
        address: null,
        countryCode: criteria.locations[0]?.countryCode || null,
        category: criteria.businessTypes[0] || null,
        rating: null,
        reviewCount: null,
        meta: { source: 'web', query: q, snippet: r.description?.slice(0, 400) || null },
      });
    }
  }

  return out;
}
