import { prisma } from './prisma.js';

/**
 * Every rule that can stop a send lives here, and send.service.js runs all
 * of them on every message. They are centralised rather than scattered
 * through the routes so there is exactly one path to the outside world and
 * no way to add a second one by accident.
 */

const OPT_IN_ONLY = new Set(
  (process.env.OPT_IN_ONLY_REGIONS || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);

export const DAILY_SEND_CAP = Number(process.env.DAILY_SEND_CAP || 50);
export const PER_CAMPAIGN_DAILY_CAP = Number(process.env.PER_CAMPAIGN_DAILY_CAP || 25);
export const MIN_SECONDS_BETWEEN_SENDS = Number(process.env.MIN_SECONDS_BETWEEN_SENDS || 45);
const MAX_BOUNCE_RATE = Number(process.env.MAX_BOUNCE_RATE || 0.05);
const MAX_COMPLAINT_RATE = Number(process.env.MAX_COMPLAINT_RATE || 0.001);

const today = () => new Date().toISOString().slice(0, 10);

export function isOptInOnlyRegion(countryCode) {
  if (!countryCode) return false;
  return OPT_IN_ONLY.has(countryCode.toUpperCase());
}

/**
 * Whether a prospect in a consent-required region can lawfully be emailed.
 *
 * A blanket country block would be simpler but wrong, and wrong in the
 * direction that makes the tool useless across the UK, EU and Canada. The
 * actual rules turn on *what kind of address it is*, not just where it is:
 *
 *  - UK PECR reg. 22 restricts unsolicited marketing to "individual
 *    subscribers". Corporate bodies (Ltd, LLP) are not individual
 *    subscribers, so B2B mail to a company's own published inbox is
 *    permitted, with identification and opt-out. Sole traders and
 *    partnerships count as individuals and are not.
 *  - CASL s.10(9)(b) grants implied consent where the recipient has
 *    conspicuously published the address, has not attached a no-unsolicited
 *    notice, and the message is relevant to their business role.
 *  - GDPR treats a named individual's work address (jane.smith@acme.com) as
 *    personal data; a generic role inbox (info@acme.com) is not personal
 *    data at all.
 *
 * All three converge on the same distinction, which is exactly what the
 * enrichment step already records: a role address the business published
 * on its own site is sendable; a named individual's address is not.
 *
 * This is a defensible reading, not legal advice, and it is deliberately
 * the conservative side of each rule. Sole traders are indistinguishable
 * from companies in listing data, which is the main residual risk.
 */
export function regionGate({ countryCode, emailSource, isRoleAddress }) {
  if (!isOptInOnlyRegion(countryCode)) return { allowed: true };

  const publishedBySelf = ['site_contact_page', 'site_mailto', 'site_text', 'osm'].includes(emailSource);

  if (publishedBySelf && isRoleAddress) {
    return { allowed: true, basis: 'published role address' };
  }
  if (!publishedBySelf) {
    return {
      allowed: false,
      reason: `${countryCode} requires consent, and this address was not published by the business itself`,
    };
  }
  return {
    allowed: false,
    reason: `${countryCode} requires consent, and this looks like a named individual's address rather than a company inbox`,
  };
}

export async function isSuppressed(email) {
  if (!email) return true;
  const hit = await prisma.suppression.findUnique({
    where: { email: email.toLowerCase() },
  });
  return Boolean(hit);
}

export async function suppress(email, reason) {
  if (!email) return;
  await prisma.suppression.upsert({
    where: { email: email.toLowerCase() },
    create: { email: email.toLowerCase(), reason },
    update: {}, // first reason wins; never downgrade or overwrite
  });
}

/** Remaining sends allowed right now, across all campaigns. */
export async function remainingDailyQuota() {
  const row = await prisma.sendQuota.findUnique({ where: { day: today() } });
  return Math.max(0, DAILY_SEND_CAP - (row?.count || 0));
}

export async function consumeDailyQuota() {
  const day = today();
  const row = await prisma.sendQuota.upsert({
    where: { day },
    create: { day, count: 1 },
    update: { count: { increment: 1 } },
  });
  return row.count;
}

export async function campaignSentToday(campaignId) {
  const since = new Date(`${today()}T00:00:00.000Z`);
  return prisma.send.count({
    where: { campaignId, status: 'sent', sentAt: { gte: since } },
  });
}

export async function lastSendAt() {
  const last = await prisma.send.findFirst({
    where: { status: 'sent' },
    orderBy: { sentAt: 'desc' },
    select: { sentAt: true },
  });
  return last?.sentAt || null;
}

/**
 * Bounce and complaint rates over the campaign's most recent 100 delivered
 * attempts. Crossing either threshold pauses the campaign and requires a
 * human to resume it — an automatic resume would just repeat whatever
 * caused the spike.
 */
export async function checkHealthAndMaybePause(campaignId) {
  const recent = await prisma.send.findMany({
    where: { campaignId, status: { in: ['sent', 'bounced', 'complained'] } },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { status: true },
  });

  // Rates over a handful of sends are noise, not signal.
  if (recent.length < 20) return null;

  const bounces = recent.filter((s) => s.status === 'bounced').length;
  const complaints = recent.filter((s) => s.status === 'complained').length;
  const bounceRate = bounces / recent.length;
  const complaintRate = complaints / recent.length;

  let reason = null;
  if (bounceRate > MAX_BOUNCE_RATE) {
    reason = `Bounce rate ${(bounceRate * 100).toFixed(1)}% exceeds the ${(MAX_BOUNCE_RATE * 100).toFixed(1)}% limit. Your address sources are bad — fix them before sending again.`;
  } else if (complaintRate > MAX_COMPLAINT_RATE) {
    reason = `Complaint rate ${(complaintRate * 100).toFixed(2)}% exceeds the ${(MAX_COMPLAINT_RATE * 100).toFixed(2)}% limit. Recipients are marking this as spam.`;
  }

  if (reason) {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'paused', pausedReason: reason, pausedAt: new Date() },
    });
  }
  return reason;
}

/**
 * Full pre-send gate. Returns { ok } or { ok: false, reason, terminal }.
 * `terminal` distinguishes "never send this prospect" from "not right now";
 * `status` is the prospect status a terminal block should write.
 */
export async function canSend({ campaign, prospect }) {
  if (campaign.status === 'paused') {
    return { ok: false, reason: campaign.pausedReason || 'Campaign is paused', terminal: false };
  }
  if (!prospect.email) {
    return { ok: false, reason: 'No contact address', terminal: true, status: 'no_email' };
  }
  const region = regionGate({
    countryCode: prospect.countryCode,
    emailSource: prospect.emailSource,
    isRoleAddress: prospect.meta?.isRoleAddress ?? prospect.emailSource === 'osm',
  });
  if (!region.allowed) {
    return { ok: false, reason: region.reason, terminal: true, status: 'blocked_region' };
  }
  if (await isSuppressed(prospect.email)) {
    return { ok: false, reason: 'Address is on the suppression list', terminal: true, status: 'suppressed' };
  }
  if ((await remainingDailyQuota()) <= 0) {
    return { ok: false, reason: `Daily cap of ${DAILY_SEND_CAP} reached`, terminal: false };
  }
  if ((await campaignSentToday(campaign.id)) >= PER_CAMPAIGN_DAILY_CAP) {
    return {
      ok: false,
      reason: `Campaign daily cap of ${PER_CAMPAIGN_DAILY_CAP} reached`,
      terminal: false,
    };
  }
  const last = await lastSendAt();
  if (last) {
    const elapsed = (Date.now() - last.getTime()) / 1000;
    if (elapsed < MIN_SECONDS_BETWEEN_SENDS) {
      return {
        ok: false,
        reason: `Throttled — ${Math.ceil(MIN_SECONDS_BETWEEN_SENDS - elapsed)}s until the next send`,
        terminal: false,
      };
    }
  }
  return { ok: true };
}
