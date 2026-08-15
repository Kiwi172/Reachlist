import axios from 'axios';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiError extends Error {}

/**
 * One call into Gemini with a forced JSON response shape.
 *
 * responseSchema is what makes this usable as a pipeline stage rather than
 * a chat toy — Gemini constrains decoding to the schema, so we get parseable
 * JSON instead of a fenced code block we'd have to scrape. The schema
 * dialect is OpenAPI-flavoured and notably does NOT support additional
 * keywords like `additionalProperties`, so keep these definitions plain.
 */
async function generateJson({ prompt, schema, temperature = 0.4 }) {
  if (!API_KEY) {
    throw new GeminiError(
      'GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey',
    );
  }

  let res;
  try {
    res = await axios.post(
      `${BASE}/${MODEL}:generateContent?key=${API_KEY}`,
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      },
      { timeout: 45_000 },
    );
  } catch (err) {
    // The free tier returns 429 under fairly light use. Surfacing this
    // distinctly matters because the caller can retry it, unlike a 400.
    if (err.response?.status === 429) {
      throw new GeminiError('Gemini free-tier rate limit hit. Wait a minute and retry.');
    }
    const detail = err.response?.data?.error?.message || err.message;
    throw new GeminiError(`Gemini request failed: ${detail}`);
  }

  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    // Usually a safety block or an empty candidate list.
    const reason = res.data?.candidates?.[0]?.finishReason || 'unknown';
    throw new GeminiError(`Gemini returned no content (finishReason: ${reason})`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError('Gemini returned malformed JSON despite a response schema');
  }
}

// --- criteria generation ----------------------------------------------------

const CRITERIA_SCHEMA = {
  type: 'object',
  properties: {
    audienceSummary: { type: 'string' },
    discoveryMode: { type: 'string', enum: ['places', 'web'] },
    discoveryModeReason: { type: 'string' },
    businessTypes: { type: 'array', items: { type: 'string' } },
    industries: { type: 'array', items: { type: 'string' } },
    locations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          countryCode: { type: 'string' },
        },
        required: ['label', 'countryCode'],
      },
    },
    sizeHint: { type: 'string' },
    buyingSignals: { type: 'array', items: { type: 'string' } },
    disqualifiers: { type: 'array', items: { type: 'string' } },
    searchQueries: { type: 'array', items: { type: 'string' } },
    valueProposition: { type: 'string' },
  },
  required: [
    'audienceSummary',
    'discoveryMode',
    'discoveryModeReason',
    'businessTypes',
    'industries',
    'locations',
    'sizeHint',
    'buyingSignals',
    'disqualifiers',
    'searchQueries',
    'valueProposition',
  ],
};

/**
 * Turn a plain-English product description into structured targeting
 * criteria. The output is always shown to the user for edit before it
 * drives any discovery.
 */
export async function generateCriteria({ productName, productDescription, locationHint }) {
  const prompt = `You are a B2B go-to-market analyst. Given a product, define the ideal
customer profile as structured targeting criteria.

PRODUCT NAME: ${productName}
PRODUCT DESCRIPTION: ${productDescription}
${locationHint ? `GEOGRAPHIC FOCUS: ${locationHint}` : 'GEOGRAPHIC FOCUS: not specified — infer a sensible default and say so in audienceSummary.'}

Rules:
- discoveryMode: choose "places" if the buyers are physical, location-bound
  businesses findable on a map (restaurants, gyms, clinics, salons, garages,
  retail, contractors). Choose "web" if they are online-first businesses with
  no meaningful physical footprint (SaaS, agencies, e-commerce, marketplaces).
  Explain the choice in discoveryModeReason.
- businessTypes: 3-8 concrete business categories, in the words the business
  would use for itself. For "places" mode these must read like map categories
  ("dental clinic", "crossfit gym"). For "web" mode, like industry labels.
- locations: specific enough to search. City or metro level for "places" mode,
  country level is fine for "web". countryCode must be ISO 3166-1 alpha-2.
- buyingSignals: observable, checkable traits suggesting this business would
  actually benefit. Not demographics — things visible on their website or
  listing. Example: "has online booking but no automated reminders".
- disqualifiers: traits that make a business a bad fit or a waste of a send.
- searchQueries: 4-8 literal search-engine queries that would surface these
  businesses. No boolean operators, no site: filters — plain queries.
- valueProposition: one sentence, specific, no marketing adjectives, framed
  around the problem the buyer already has.

Be concrete and restrictive. A narrow, accurate profile is far more useful
than a broad one.`;

  return generateJson({ prompt, schema: CRITERIA_SCHEMA, temperature: 0.5 });
}

// --- prospect scoring -------------------------------------------------------

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          score: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['id', 'score', 'reason'],
      },
    },
  },
  required: ['results'],
};

/**
 * Score a batch of discovered businesses against the criteria. Batched
 * because the free tier's request-per-minute limit is the binding
 * constraint, not tokens.
 */
export async function scoreProspects({ criteria, prospects }) {
  const compact = prospects.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    address: p.address,
    website: p.websiteUrl,
    rating: p.rating,
    reviewCount: p.reviewCount,
    snippet: p.meta?.snippet,
  }));

  const prompt = `Score how well each business matches this ideal customer profile.

CRITERIA:
${JSON.stringify(criteria, null, 2)}

BUSINESSES:
${JSON.stringify(compact, null, 2)}

For each business return:
- id: echo the id exactly
- score: 0 to 1. Be harsh. 0.8+ means it clearly matches the business types,
  location and buying signals. Below 0.4 means it should not be contacted.
  Anything hitting a disqualifier scores 0.
- reason: one short clause explaining the score, citing a concrete detail.

Return one entry for every business given.`;

  const out = await generateJson({ prompt, schema: SCORE_SCHEMA, temperature: 0.2 });
  return out.results || [];
}

// --- draft generation -------------------------------------------------------

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['subject', 'body'],
};

/**
 * Write one outreach email. Deliberately generates the body WITHOUT the
 * unsubscribe footer or postal address — those are appended by the sender
 * so they cannot be hallucinated away or edited out in the review UI.
 */
export async function generateDraft({ criteria, product, prospect, senderName }) {
  const prompt = `Write a short cold outreach email from a real person to a business.

SENDER: ${senderName}
PRODUCT: ${product.name}
WHAT IT DOES: ${product.description}
VALUE PROPOSITION: ${criteria.valueProposition}

RECIPIENT BUSINESS:
${JSON.stringify(
  {
    name: prospect.name,
    category: prospect.category,
    address: prospect.address,
    website: prospect.websiteUrl,
    rating: prospect.rating,
    reviewCount: prospect.reviewCount,
    whyMatched: prospect.matchReason,
  },
  null,
  2,
)}

Rules:
- Under 120 words. Four short paragraphs maximum.
- Open with a specific, verifiable detail about THIS business, drawn only
  from the data above. If there is no such detail, open plainly instead —
  never invent a fact, a compliment, or a claim about having used them.
- State plainly that this is an unsolicited email and how you found them.
  One short clause is enough. People respond better to it, and pretending
  to a prior relationship is exactly what spam filters and recipients both
  punish.
- One clear ask, and make it low-commitment — a reply, not a meeting.
- No marketing adjectives. No "I hope this finds you well". No fake urgency.
- Plain text. No markdown, no links, no signature block, no unsubscribe
  line — those are appended automatically afterwards.
- Subject: under 55 characters, lowercase, specific, not a question.`;

  return generateJson({ prompt, schema: DRAFT_SCHEMA, temperature: 0.7 });
}
