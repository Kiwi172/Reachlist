import { prisma } from '../lib/prisma.js';
import { normalizeCriteria, validateCriteria } from '../lib/criteria.js';
import { generateCriteria, scoreProspects, generateDraft, GeminiError } from '../services/gemini.service.js';
import { discover } from '../discovery/index.js';
import { findContactEmail } from '../services/enrich.service.js';
import { sendProspect } from '../services/send.service.js';
import { regionGate, isSuppressed, remainingDailyQuota } from '../lib/compliance.js';

const owned = async (userId, campaignId) => {
  const c = await prisma.campaign.findFirst({
    where: { id: campaignId, userId },
    include: { product: true },
  });
  if (!c) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  return c;
};

// --- products ---------------------------------------------------------------

export async function listProducts(req, res, next) {
  try {
    res.json({
      products: await prisma.product.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
      }),
    });
  } catch (err) {
    next(err);
  }
}

export async function createProduct(req, res, next) {
  try {
    const { name, description, websiteUrl } = req.body || {};
    if (!name || !description) {
      return res.status(400).json({ error: 'Name and description are required' });
    }
    if (description.length < 30) {
      return res.status(400).json({
        error: 'Describe the product in at least 30 characters — vague descriptions produce vague targeting.',
      });
    }
    const product = await prisma.product.create({
      data: {
        userId: req.user.id,
        name: name.slice(0, 200),
        description: description.slice(0, 4000),
        websiteUrl: websiteUrl || null,
      },
    });
    res.json({ product });
  } catch (err) {
    next(err);
  }
}

// --- campaigns --------------------------------------------------------------

export async function listCampaigns(req, res, next) {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        product: { select: { name: true } },
        _count: { select: { prospects: true, sends: true } },
      },
    });
    res.json({ campaigns });
  } catch (err) {
    next(err);
  }
}

export async function getCampaign(req, res, next) {
  try {
    const campaign = await owned(req.user.id, req.params.id);
    const counts = await prisma.prospect.groupBy({
      by: ['status'],
      where: { campaignId: campaign.id },
      _count: true,
    });
    res.json({
      campaign,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
      remainingDailyQuota: await remainingDailyQuota(),
    });
  } catch (err) {
    next(err);
  }
}

/** Creates a campaign and has the AI propose criteria for it. */
export async function createCampaign(req, res, next) {
  try {
    const { productId, name, locationHint } = req.body || {};
    const product = await prisma.product.findFirst({
      where: { id: productId, userId: req.user.id },
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    let criteria;
    try {
      criteria = normalizeCriteria(
        await generateCriteria({
          productName: product.name,
          productDescription: product.description,
          locationHint,
        }),
      );
    } catch (err) {
      if (err instanceof GeminiError) return res.status(502).json({ error: err.message });
      throw err;
    }

    const campaign = await prisma.campaign.create({
      data: {
        userId: req.user.id,
        productId: product.id,
        name: name?.slice(0, 200) || `${product.name} — ${new Date().toISOString().slice(0, 10)}`,
        criteria,
        discoveryMode: criteria.discoveryMode,
        status: 'draft',
      },
    });
    res.json({ campaign });
  } catch (err) {
    next(err);
  }
}

/** User edits to the AI's criteria. Re-normalised, never trusted as-is. */
export async function updateCriteria(req, res, next) {
  try {
    const campaign = await owned(req.user.id, req.params.id);
    if (campaign.status === 'discovering') {
      return res.status(409).json({ error: 'Discovery is running — wait for it to finish' });
    }
    const criteria = normalizeCriteria(req.body?.criteria);
    const errors = validateCriteria(criteria);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });

    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        criteria,
        discoveryMode: req.body?.discoveryMode === 'web' ? 'web' : req.body?.discoveryMode === 'places' ? 'places' : campaign.discoveryMode,
      },
    });
    res.json({ campaign: updated });
  } catch (err) {
    next(err);
  }
}

// --- discovery --------------------------------------------------------------

/**
 * Records a found address and decides whether the prospect is sendable.
 *
 * The region gate lands here rather than at discovery time because it
 * depends on what kind of address was found, which isn't known until the
 * site has been read. Blocked prospects are kept with an explanatory note
 * so the reason is visible in the UI instead of them vanishing.
 */
async function applyEnrichment(row, found) {
  const region = regionGate({
    countryCode: row.countryCode,
    emailSource: found.source,
    isRoleAddress: found.isRole,
  });

  let status = 'enriched';
  if (!region.allowed) status = 'blocked_region';
  else if (await isSuppressed(found.email)) status = 'suppressed';

  await prisma.prospect.update({
    where: { id: row.id },
    data: {
      email: found.email,
      emailSource: found.source,
      status,
      meta: {
        ...row.meta,
        isRoleAddress: found.isRole,
        blockReason: region.allowed ? undefined : region.reason,
        lawfulBasis: region.basis,
      },
    },
  });
}

/**
 * Discovery, enrichment and scoring for one campaign.
 *
 * Runs detached from the request because a full pass is minutes of network
 * work. Progress is observable through the campaign status and prospect
 * counts rather than a job queue — adequate at this scale, and it keeps the
 * deployment to one process plus Postgres.
 */
async function runDiscovery(campaignId) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return;

  try {
    const { prospects, warnings, source } = await discover({
      criteria: campaign.criteria,
      mode: campaign.discoveryMode,
    });

    const existing = await prisma.prospect.findMany({
      where: { campaignId },
      select: { domain: true },
    });
    const known = new Set(existing.map((p) => p.domain).filter(Boolean));

    const created = [];
    for (const p of prospects) {
      if (p.domain && known.has(p.domain)) continue;
      if (p.domain) known.add(p.domain);

      const row = await prisma.prospect.create({
        data: {
          campaignId,
          name: p.name,
          domain: p.domain || null,
          websiteUrl: p.websiteUrl || null,
          email: p.email || null,
          emailSource: p.emailSource || null,
          phone: p.phone || null,
          address: p.address || null,
          countryCode: p.countryCode || null,
          category: p.category || null,
          rating: p.rating ?? null,
          reviewCount: p.reviewCount ?? null,
          meta: { ...p.meta, discoverySource: source, warnings: warnings.length ? warnings : undefined },
          status: 'pending',
        },
      });
      created.push(row);
    }

    for (const row of created) {
      // Addresses that came straight from the source (OSM publishes them)
      // skip the crawl but still go through the region gate below.
      if (row.email) {
        await applyEnrichment(row, { email: row.email, source: row.emailSource, isRole: true });
        continue;
      }
      if (!row.websiteUrl) {
        await prisma.prospect.update({ where: { id: row.id }, data: { status: 'no_email' } });
        continue;
      }
      let found;
      try {
        found = await findContactEmail({ websiteUrl: row.websiteUrl });
      } catch {
        found = { email: null, reason: 'site unreachable' };
      }

      if (!found.email) {
        await prisma.prospect.update({
          where: { id: row.id },
          data: { status: 'no_email', meta: { ...row.meta, enrichNote: found.reason } },
        });
        continue;
      }
      await applyEnrichment(row, found);
    }

    // Score everything sendable, in batches the free tier tolerates.
    const sendable = await prisma.prospect.findMany({
      where: { campaignId, status: 'enriched', matchScore: null },
    });
    for (let i = 0; i < sendable.length; i += 15) {
      const batch = sendable.slice(i, i + 15);
      try {
        const scores = await scoreProspects({ criteria: campaign.criteria, prospects: batch });
        for (const s of scores) {
          if (!batch.some((b) => b.id === s.id)) continue;
          await prisma.prospect.update({
            where: { id: s.id },
            data: {
              matchScore: Math.max(0, Math.min(1, Number(s.score) || 0)),
              matchReason: String(s.reason || '').slice(0, 500),
            },
          });
        }
      } catch (err) {
        // Scoring is an ordering aid, not a gate — a failure here leaves
        // prospects unscored rather than losing the whole discovery run.
        console.error('Scoring batch failed:', err.message);
      }
    }

    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'ready' } });
  } catch (err) {
    console.error('Discovery failed:', err);
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'draft', pausedReason: `Discovery failed: ${err.message}`.slice(0, 500) },
    });
  }
}

export async function startDiscovery(req, res, next) {
  try {
    const campaign = await owned(req.user.id, req.params.id);
    if (campaign.status === 'discovering') {
      return res.status(409).json({ error: 'Discovery is already running' });
    }
    const errors = validateCriteria(normalizeCriteria(campaign.criteria));
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'discovering', pausedReason: null },
    });
    runDiscovery(campaign.id); // detached on purpose
    res.json({ started: true });
  } catch (err) {
    next(err);
  }
}

// --- prospects and drafts ---------------------------------------------------

export async function listProspects(req, res, next) {
  try {
    const campaign = await owned(req.user.id, req.params.id);
    const { status } = req.query;
    const prospects = await prisma.prospect.findMany({
      where: { campaignId: campaign.id, ...(status ? { status: String(status) } : {}) },
      orderBy: [{ matchScore: 'desc' }, { createdAt: 'asc' }],
      include: { draft: true },
      take: 500,
    });
    res.json({ prospects });
  } catch (err) {
    next(err);
  }
}

/** Drafts emails for the highest-scoring sendable prospects. */
export async function generateDrafts(req, res, next) {
  try {
    const campaign = await owned(req.user.id, req.params.id);
    const limit = Math.min(Number(req.body?.limit) || 10, 25);
    const minScore = Number(req.body?.minScore ?? 0.5);

    const targets = await prisma.prospect.findMany({
      where: {
        campaignId: campaign.id,
        status: 'enriched',
        draft: { is: null },
        OR: [{ matchScore: { gte: minScore } }, { matchScore: null }],
      },
      orderBy: { matchScore: 'desc' },
      take: limit,
    });

    const results = [];
    for (const prospect of targets) {
      try {
        const { subject, body } = await generateDraft({
          criteria: campaign.criteria,
          product: campaign.product,
          prospect,
          senderName: req.user.name || req.user.email,
        });
        await prisma.$transaction([
          prisma.draft.create({
            data: { prospectId: prospect.id, subject: subject.slice(0, 300), body: body.slice(0, 8000) },
          }),
          prisma.prospect.update({ where: { id: prospect.id }, data: { status: 'drafted' } }),
        ]);
        results.push({ id: prospect.id, ok: true });
      } catch (err) {
        results.push({ id: prospect.id, ok: false, error: err.message });
      }
    }
    res.json({ drafted: results.filter((r) => r.ok).length, results });
  } catch (err) {
    next(err);
  }
}

export async function updateDraft(req, res, next) {
  try {
    const draft = await prisma.draft.findUnique({
      where: { id: req.params.draftId },
      include: { prospect: { include: { campaign: true } } },
    });
    if (!draft || draft.prospect.campaign.userId !== req.user.id) {
      return res.status(404).json({ error: 'Draft not found' });
    }
    const updated = await prisma.draft.update({
      where: { id: draft.id },
      data: {
        editedSubject: req.body?.subject?.slice(0, 300) ?? draft.editedSubject,
        editedBody: req.body?.body?.slice(0, 8000) ?? draft.editedBody,
      },
    });
    res.json({ draft: updated });
  } catch (err) {
    next(err);
  }
}

/** The human gate. Nothing sends without passing through here. */
export async function reviewProspect(req, res, next) {
  try {
    const { decision } = req.body || {};
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be approve or reject' });
    }
    const prospect = await prisma.prospect.findUnique({
      where: { id: req.params.prospectId },
      include: { campaign: true, draft: true },
    });
    if (!prospect || prospect.campaign.userId !== req.user.id) {
      return res.status(404).json({ error: 'Prospect not found' });
    }
    if (decision === 'approve' && !prospect.draft) {
      return res.status(400).json({ error: 'Nothing to approve — generate a draft first' });
    }

    if (decision === 'approve') {
      await prisma.$transaction([
        prisma.draft.update({ where: { id: prospect.draft.id }, data: { approvedAt: new Date() } }),
        prisma.prospect.update({ where: { id: prospect.id }, data: { status: 'approved' } }),
      ]);
    } else {
      await prisma.prospect.update({ where: { id: prospect.id }, data: { status: 'rejected' } });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// --- sending ----------------------------------------------------------------

export async function sendApproved(req, res, next) {
  try {
    const campaign = await owned(req.user.id, req.params.id);
    if (campaign.status === 'paused') {
      return res.status(409).json({ error: campaign.pausedReason || 'Campaign is paused' });
    }

    const approved = await prisma.prospect.findMany({
      where: { campaignId: campaign.id, status: 'approved' },
      orderBy: { matchScore: 'desc' },
      take: Math.min(Number(req.body?.limit) || 10, 50),
    });

    const results = [];
    for (const prospect of approved) {
      const out = await sendProspect({ campaign, prospect });
      results.push({ id: prospect.id, name: prospect.name, ...out });
      // A non-terminal block (cap reached, throttle, pause) applies to every
      // remaining prospect too, so stop rather than grinding through them.
      if (!out.sent && out.terminal === false) break;
    }

    res.json({
      sent: results.filter((r) => r.sent).length,
      results,
      remainingDailyQuota: await remainingDailyQuota(),
    });
  } catch (err) {
    next(err);
  }
}

export async function resumeCampaign(req, res, next) {
  try {
    const campaign = await owned(req.user.id, req.params.id);
    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'ready', pausedReason: null, pausedAt: null },
    });
    res.json({ campaign: updated });
  } catch (err) {
    next(err);
  }
}
