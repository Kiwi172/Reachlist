# Reachlist

Describe a product in plain English; an AI builds a targeting profile from it,
finds businesses that match, locates their published contact addresses, drafts
a personalised email for each, and sends only what you approve.

Works for any number of products — a product is just a description, and each
campaign targets one.

There are two front doors:

- **The app** (`/dashboard`) — the full pipeline, behind a login.
- **The public site** (`/`) — an ad-supported free tool that generates criteria
  and shows matching businesses, with no enrichment and no sending. That's the
  ad inventory, and the upgrade boundary.

---

## Pipeline

```
product description
  └─ Gemini ............. structured targeting criteria  ← you review and edit
      └─ discovery ...... Google Places / OpenStreetMap / Brave Search
          └─ enrichment . read each business's own contact page
              └─ Gemini . match score, then a per-business draft
                  └─ REVIEW QUEUE  ← nothing passes here without you
                      └─ sender .. caps, suppression, unsubscribe footer
```

## Setup

Everything runs through Docker; no Node install needed on the host.

```bash
docker compose up -d db
```

Build the helper image once (Debian-based — Prisma's engines don't load on
Alpine's musl):

```bash
docker build -t outreach-dev - <<'EOF'
FROM node:20-bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
EOF
```

Then install and migrate:

```bash
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/backend":/app -w /app outreach-dev bash -c "npm install && npx prisma migrate deploy"
```

Copy `backend/.env.example` to `backend/.env` and set `JWT_SECRET` plus
`GEMINI_API_KEY`. Same for `frontend/.env.example`.

Run both:

```bash
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/backend":/app -w /app outreach-dev node src/index.js
```

```bash
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/frontend":/app -w /app outreach-dev npx vite --host
```

API on `:4001`, web on `:5174`, Postgres on `5433` — all offset from the usual
defaults so they don't collide with anything else running on the host.

## Keys

| Service | Needed for | Notes |
|---|---|---|
| [Gemini](https://aistudio.google.com/apikey) | criteria, scoring, drafts | Required. Free tier on Flash models: ~10 req/min. |
| [Google Places](https://console.cloud.google.com/) | local business discovery | Optional. Falls back to OpenStreetMap, which is keyless but has patchier coverage and fewer websites. |
| [Brave Search](https://api-dashboard.search.brave.com/) | online business discovery | Only needed for `web` mode. New accounts get a metered credit, not an open free tier. |
| Amazon SES | sending | Only when you're ready to send for real. |

`SEND_PROVIDER=console` is the default and prints emails to stdout instead of
sending them, so the whole pipeline is exercisable before a domain is at risk.

## Verifying

```bash
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/backend":/app -w /app outreach-dev node scripts/verify-send-path.js
```

Seeds prospects that should each hit a different gate, sends against the
console provider, and asserts the outcomes — region rules, suppression,
unsubscribe round-trip, daily cap. 14 checks, no external APIs, nothing leaves
the machine.

```bash
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/backend":/app -w /app outreach-dev node scripts/try-enrich.js https://example.com
```

Runs the contact crawler against a real site.

---

## Before you send anything real

This part matters more than the code.

**Use a separate domain and a separate provider.** Resend, Postmark and
SendGrid all prohibit cold outreach in their acceptable-use policies — sending
this traffic through the key that also sends your login codes gets that key
banned and takes your transactional mail down with it. SES permits cold B2B
provided bounces stay under 5% and complaints under 0.1%.

**Authenticate the domain.** SPF, DKIM and DMARC, all three. Unauthenticated
bulk mail to Gmail or Yahoo is rejected outright now, regardless of content.

**Warm it up.** The default caps (50/day globally, 25/campaign, 45s apart) are
deliberately low. A cold domain that emits 500 messages on day one lands in
spam permanently. Raise them over weeks, not days.

**Set `SENDER_POSTAL_ADDRESS`.** CAN-SPAM requires a valid physical address in
every commercial message, with no small-sender exemption. The footer is
appended by the sender rather than written by the AI or editable in the review
UI, specifically so it can't go missing.

### What the region gate actually does

`OPT_IN_ONLY_REGIONS` covers the UK, EEA and Canada. It does **not** blanket-
block them — that would be both over-broad and useless. It allows sending only
to a **role address the business published on its own site** (`info@`,
`hello@`, `contact@`), and blocks named individuals (`jane.smith@`).

That line tracks the actual rules:

- **UK PECR reg. 22** restricts unsolicited marketing to *individual
  subscribers*. A limited company isn't one, so B2B mail to its own published
  inbox is permitted with identification and opt-out.
- **CASL s.10(9)(b)** grants implied consent where the address was
  conspicuously published without a no-unsolicited notice and the message is
  relevant to the recipient's role.
- **GDPR** treats a named person's work address as personal data; a generic
  role inbox is not personal data at all.

The residual risk is sole traders and partnerships, which count as individuals
under PECR but are indistinguishable from companies in listing data. If that
matters to you, drop those countries from `OPT_IN_ONLY_REGIONS` handling and
don't send there at all.

This is a considered reading, not legal advice.

### Why addresses only come from the business's own site

The crawler is the only email source in the pipeline — no pattern guessing, no
purchased lists. Guessed addresses are the main driver of hard bounces, and
they're the part with no defence under any of the regimes above. An address a
business publishes on its own contact page is the defensible case, and it's
the one CASL's implied-consent provision is written around.

## Making money from the public site

`AdSlot` renders labelled placeholders until `VITE_ADSENSE_CLIENT` is set.
Worth knowing up front: AdSense won't approve a site that's just a tool with no
content — you'll need real pages (guides on finding customers in specific
industries, worked examples) before an application succeeds. The placeholders
are what you ship in the meantime.

The free preview is capped at 10 runs/hour per IP and deliberately trimmed to
one business type and one location, because otherwise anonymous traffic burns
your entire monthly Places or Brave budget.
