import { useState } from 'react';

/** Comma-separated text <-> string[], so lists stay editable as plain text. */
function ListField({ label, hint, value, onChange }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        className="input-field"
        value={value.join(', ')}
        onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
      />
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export default function CriteriaEditor({ campaign, onSave, busy }) {
  const [criteria, setCriteria] = useState(campaign.criteria);
  const [mode, setMode] = useState(campaign.discoveryMode);
  const set = (k) => (v) => setCriteria({ ...criteria, [k]: v });

  return (
    <div className="card p-6">
      <h2 className="font-semibold">Targeting criteria</h2>
      <p className="mt-1 text-sm text-slate-500">{criteria.audienceSummary}</p>

      <div className="mt-5 space-y-4">
        <div>
          <label className="label">Discovery source</label>
          <div className="flex gap-2">
            {['places', 'web'].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                  mode === m
                    ? 'border-brand-teal bg-brand-teal-light text-brand-teal-dark'
                    : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400'
                }`}
              >
                {m === 'places' ? 'Map listings' : 'Web search'}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">{criteria.discoveryModeReason}</p>
        </div>

        <ListField
          label="Business types"
          hint="How these businesses describe themselves."
          value={criteria.businessTypes}
          onChange={set('businessTypes')}
        />

        <div>
          <label className="label">Locations</label>
          <input
            className="input-field"
            value={criteria.locations.map((l) => `${l.label} (${l.countryCode})`).join(', ')}
            onChange={(e) =>
              set('locations')(
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((s) => {
                    // Accept "Leeds (GB)" and bare "Leeds" alike.
                    const m = s.match(/^(.*?)\s*\(([A-Za-z]{2})\)$/);
                    return m
                      ? { label: m[1].trim(), countryCode: m[2].toUpperCase() }
                      : { label: s, countryCode: '' };
                  }),
              )
            }
          />
          <p className="mt-1 text-xs text-slate-500">
            Format: <code>City (GB)</code>. The country code drives the opt-in check, so keep it accurate.
          </p>
        </div>

        <ListField label="Buying signals" value={criteria.buyingSignals} onChange={set('buyingSignals')} />
        <ListField label="Disqualifiers" value={criteria.disqualifiers} onChange={set('disqualifiers')} />

        {mode === 'web' && (
          <ListField
            label="Search queries"
            hint="Used verbatim against the search API."
            value={criteria.searchQueries}
            onChange={set('searchQueries')}
          />
        )}

        <div>
          <label className="label">Value proposition</label>
          <textarea
            className="input-field min-h-20"
            value={criteria.valueProposition}
            onChange={(e) => set('valueProposition')(e.target.value)}
          />
        </div>
      </div>

      <button className="btn-secondary mt-5" disabled={busy} onClick={() => onSave({ criteria, discoveryMode: mode })}>
        Save criteria
      </button>
    </div>
  );
}
