/**
 * Normalisation and validation for criteria objects.
 *
 * Criteria arrive from two untrusted directions — Gemini's generation and
 * the user's edits in the review UI — and then get interpolated into
 * search queries and prompts. Everything is clamped here so a malformed or
 * oversized field can't blow up a discovery run downstream.
 */

const MAX_ITEMS = 20;
const MAX_STR = 300;

function str(v, max = MAX_STR) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

function strArray(v, max = MAX_ITEMS) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => str(x))
    .filter(Boolean)
    .slice(0, max);
}

export function normalizeCriteria(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};

  const locations = (Array.isArray(input.locations) ? input.locations : [])
    .map((l) => ({
      label: str(l?.label, 120),
      // Anything that isn't a plausible ISO-2 code becomes empty rather
      // than a guess — region gating keys off this, so a wrong value is
      // worse than a missing one.
      countryCode: /^[A-Za-z]{2}$/.test(l?.countryCode || '')
        ? l.countryCode.toUpperCase()
        : '',
    }))
    .filter((l) => l.label)
    .slice(0, MAX_ITEMS);

  return {
    audienceSummary: str(input.audienceSummary, 1000),
    discoveryMode: input.discoveryMode === 'web' ? 'web' : 'places',
    discoveryModeReason: str(input.discoveryModeReason, 500),
    businessTypes: strArray(input.businessTypes),
    industries: strArray(input.industries),
    locations,
    sizeHint: str(input.sizeHint, 200),
    buyingSignals: strArray(input.buyingSignals),
    disqualifiers: strArray(input.disqualifiers),
    searchQueries: strArray(input.searchQueries, 12),
    valueProposition: str(input.valueProposition, 500),
  };
}

/** Human-readable problems that should block a discovery run. */
export function validateCriteria(c) {
  const errors = [];
  if (!c.businessTypes.length) errors.push('At least one business type is required.');
  if (!c.locations.length) errors.push('At least one location is required.');
  if (c.discoveryMode === 'web' && !c.searchQueries.length) {
    errors.push('Web discovery needs at least one search query.');
  }
  return errors;
}
