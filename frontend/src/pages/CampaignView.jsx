import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errText } from '../api/client.js';
import CriteriaEditor from '../components/CriteriaEditor.jsx';
import ProspectCard from '../components/ProspectCard.jsx';

const FILTERS = [
  ['', 'All'],
  ['enriched', 'Ready to draft'],
  ['drafted', 'Needs review'],
  ['approved', 'Approved'],
  ['sent', 'Sent'],
  ['no_email', 'No address'],
  ['blocked_region', 'Blocked'],
];

export default function CampaignView() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [prospects, setProspects] = useState([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([
        api.get(`/api/campaigns/${id}`),
        api.get(`/api/campaigns/${id}/prospects`, { params: filter ? { status: filter } : {} }),
      ]);
      setData(c.data);
      setProspects(p.data.prospects);
      return c.data.campaign.status;
    } catch (err) {
      setError(errText(err));
      return null;
    }
  }, [id, filter]);

  useEffect(() => {
    load();
  }, [load]);

  // Discovery runs detached on the server, so the page polls while it's in
  // flight and stops as soon as it settles.
  useEffect(() => {
    if (data?.campaign.status !== 'discovering') {
      clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(async () => {
      const status = await load();
      if (status !== 'discovering') clearInterval(pollRef.current);
    }, 4000);
    return () => clearInterval(pollRef.current);
  }, [data?.campaign.status, load]);

  const act = async (fn, successMsg) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const msg = await fn();
      if (successMsg || msg) setNotice(msg || successMsg);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return <div className="p-10 text-center text-slate-500">{error || 'Loading…'}</div>;
  }

  const { campaign, counts, remainingDailyQuota } = data;

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <div>
        <Link to="/dashboard" className="link text-sm">← Campaigns</Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{campaign.name}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {campaign.product.name} · {campaign.status} · {remainingDailyQuota} sends left today
        </p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded-lg bg-brand-teal-light px-4 py-3 text-sm text-brand-teal-dark">{notice}</p>}

      {campaign.pausedReason && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="font-medium text-red-800">Campaign paused</p>
          <p className="mt-1 text-sm text-red-700">{campaign.pausedReason}</p>
          <button
            className="btn-secondary mt-3"
            disabled={busy}
            onClick={() => act(() => api.post(`/api/campaigns/${id}/resume`), 'Campaign resumed.')}
          >
            Resume anyway
          </button>
        </div>
      )}

      <CriteriaEditor
        campaign={campaign}
        busy={busy}
        onSave={(payload) => act(() => api.patch(`/api/campaigns/${id}/criteria`, payload), 'Criteria saved.')}
      />

      <div className="card flex flex-wrap items-center gap-3 p-4">
        <button
          className="btn-primary"
          disabled={busy || campaign.status === 'discovering'}
          onClick={() => act(() => api.post(`/api/campaigns/${id}/discover`), 'Discovery started — this takes a few minutes.')}
        >
          {campaign.status === 'discovering' ? 'Finding businesses…' : 'Find businesses'}
        </button>
        <button
          className="btn-secondary"
          disabled={busy || !counts.enriched}
          onClick={() =>
            act(async () => {
              const res = await api.post(`/api/campaigns/${id}/drafts`, { limit: 10 });
              return `Drafted ${res.data.drafted} emails.`;
            })
          }
        >
          Draft next 10
        </button>
        <button
          className="btn-primary"
          disabled={busy || !counts.approved}
          onClick={() =>
            act(async () => {
              const res = await api.post(`/api/campaigns/${id}/send`, { limit: 10 });
              const blocked = res.data.results.find((r) => !r.sent);
              return `Sent ${res.data.sent}.${blocked ? ` Stopped: ${blocked.reason}` : ''}`;
            })
          }
        >
          Send approved ({counts.approved || 0})
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
              filter === value ? 'bg-brand-teal text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            {label} {value && counts[value] ? `(${counts[value]})` : ''}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {prospects.length === 0 && (
          <p className="card p-6 text-sm text-slate-500">
            {campaign.status === 'discovering' ? 'Discovery in progress…' : 'Nothing here yet.'}
          </p>
        )}
        {prospects.map((p) => (
          <ProspectCard
            key={p.id}
            prospect={p}
            busy={busy}
            onSaveDraft={(draftId, payload) => act(() => api.patch(`/api/drafts/${draftId}`, payload), 'Draft saved.')}
            onReview={(prospectId, decision) =>
              act(() => api.post(`/api/prospects/${prospectId}/review`, { decision }), `Prospect ${decision}d.`)
            }
          />
        ))}
      </div>
    </div>
  );
}
