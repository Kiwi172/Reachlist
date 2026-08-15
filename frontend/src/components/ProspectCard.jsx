import { useState } from 'react';

const STATUS_LABEL = {
  pending: 'Awaiting enrichment',
  enriched: 'Contact found',
  no_email: 'No public contact address',
  blocked_region: 'Blocked — opt-in-only region',
  suppressed: 'Suppressed — previously opted out',
  drafted: 'Draft ready for review',
  approved: 'Approved to send',
  rejected: 'Rejected',
  sent: 'Sent',
  failed: 'Send failed',
};

const STATUS_STYLE = {
  enriched: 'bg-blue-50 text-blue-700',
  drafted: 'bg-amber-50 text-amber-700',
  approved: 'bg-brand-teal-light text-brand-teal-dark',
  sent: 'bg-slate-100 text-slate-500',
  rejected: 'bg-slate-100 text-slate-500',
  blocked_region: 'bg-red-50 text-red-700',
  suppressed: 'bg-red-50 text-red-700',
  no_email: 'bg-slate-100 text-slate-500',
  failed: 'bg-red-50 text-red-700',
};

export default function ProspectCard({ prospect, onSaveDraft, onReview, busy }) {
  const draft = prospect.draft;
  const [subject, setSubject] = useState(draft?.editedSubject ?? draft?.subject ?? '');
  const [body, setBody] = useState(draft?.editedBody ?? draft?.body ?? '');
  const [open, setOpen] = useState(false);
  const dirty = draft && (subject !== (draft.editedSubject ?? draft.subject) || body !== (draft.editedBody ?? draft.body));

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{prospect.name}</p>
          <p className="mt-0.5 truncate text-sm text-slate-500">
            {[prospect.category, prospect.address].filter(Boolean).join(' · ')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {prospect.email && <span className="chip">{prospect.email}</span>}
            {prospect.emailSource && <span className="chip">via {prospect.emailSource.replace(/_/g, ' ')}</span>}
            {typeof prospect.matchScore === 'number' && (
              <span className="chip">match {Math.round(prospect.matchScore * 100)}%</span>
            )}
            {prospect.websiteUrl && (
              <a href={prospect.websiteUrl} target="_blank" rel="noreferrer noopener" className="link text-xs">
                site ↗
              </a>
            )}
          </div>
          {prospect.matchReason && <p className="mt-2 text-sm text-slate-600">{prospect.matchReason}</p>}
          {prospect.meta?.blockReason && (
            <p className="mt-2 text-sm text-red-700">{prospect.meta.blockReason}</p>
          )}
          {prospect.meta?.enrichNote && (
            <p className="mt-2 text-sm text-slate-500">{prospect.meta.enrichNote}</p>
          )}
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[prospect.status] || 'bg-slate-100 text-slate-600'}`}>
          {STATUS_LABEL[prospect.status] || prospect.status}
        </span>
      </div>

      {draft && (
        <div className="mt-4 border-t border-slate-100 pt-4">
          <button className="link text-sm" onClick={() => setOpen(!open)}>
            {open ? 'Hide draft' : 'Review draft'}
          </button>

          {open && (
            <div className="mt-3 space-y-3">
              <div>
                <label className="label">Subject</label>
                <input className="input-field" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div>
                <label className="label">Body</label>
                <textarea className="input-field min-h-48 font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} />
                <p className="mt-1 text-xs text-slate-500">
                  An unsubscribe link and your postal address are appended automatically at send time.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" disabled={busy || !dirty} onClick={() => onSaveDraft(draft.id, { subject, body })}>
                  Save edits
                </button>
                {prospect.status !== 'approved' && prospect.status !== 'sent' && (
                  <button className="btn-primary" disabled={busy || dirty} onClick={() => onReview(prospect.id, 'approve')}>
                    Approve
                  </button>
                )}
                {prospect.status !== 'sent' && (
                  <button className="btn-danger" disabled={busy} onClick={() => onReview(prospect.id, 'reject')}>
                    Reject
                  </button>
                )}
              </div>
              {dirty && <p className="text-xs text-amber-700">Save your edits before approving.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
