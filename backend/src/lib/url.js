/** Bare registrable-ish hostname, lowercased, `www.` stripped. */
export function toDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Aggregators, directories and social platforms. In "web" discovery these
// dominate the result pages for exactly the queries we care about, and none
// of them are the business we're trying to reach.
const NON_BUSINESS_DOMAINS = new Set([
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'reddit.com', 'medium.com',
  'yelp.com', 'yellowpages.com', 'tripadvisor.com', 'trustpilot.com',
  'glassdoor.com', 'indeed.com', 'crunchbase.com', 'wikipedia.org',
  'amazon.com', 'ebay.com', 'etsy.com', 'g2.com', 'capterra.com',
  'producthunt.com', 'github.com', 'google.com', 'bing.com', 'apple.com',
  'yell.com', 'thomsonlocal.com', 'bbb.org', 'angi.com', 'houzz.com',
]);

export function isLikelyBusinessDomain(domain) {
  if (!domain) return false;
  if (NON_BUSINESS_DOMAINS.has(domain)) return false;
  // Subdomains of the above (e.g. shop.facebook.com) are out too.
  for (const d of NON_BUSINESS_DOMAINS) {
    if (domain.endsWith(`.${d}`)) return false;
  }
  return true;
}
