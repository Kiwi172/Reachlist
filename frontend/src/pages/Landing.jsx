import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errText } from '../api/client.js';
import AdSlot from '../components/AdSlot.jsx';

/**
 * The public, ad-supported side of the product.
 *
 * It runs the same criteria generation and discovery as the signed-in app
 * but stops there — no contact enrichment, no drafts, no sending. That's
 * what makes it safe to leave open to anonymous traffic, and it gives the
 * upgrade path something concrete to sell.
 */
export default function Landing() {
  const [description, setDescription] = useState('');
  const [locationHint, setLocationHint] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = await api.post('/public/preview', { description, locationHint });
      setResult(res.data);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <span className="text-lg font-semibold tracking-tight text-brand-teal">Reachlist</span>
          <div className="flex items-center gap-3">
            <Link to="/login" className="link text-sm">Sign in</Link>
            <Link to="/register" className="btn-primary py-1.5">Get started</Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-12">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Describe what you sell. See who needs it.
          </h1>
          <p className="mt-3 text-slate-600">
            Free tool: paste a product description and get a targeting profile plus real businesses that
            match it. No signup, no card.
          </p>
        </div>

        <form onSubmit={submit} className="card mx-auto mt-8 max-w-2xl space-y-3 p-6">
          <textarea
            className="input-field min-h-32"
            placeholder="e.g. A booking system for independent hair salons that cuts no-shows by sending automatic SMS reminders and taking deposits up front."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            minLength={30}
          />
          <input
            className="input-field"
            placeholder="Where are your customers? e.g. Leeds, UK (optional)"
            value={locationHint}
            onChange={(e) => setLocationHint(e.target.value)}
          />
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? 'Analysing…' : 'Find my customers'}
          </button>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </form>

        <AdSlot slot={import.meta.env.VITE_ADSENSE_SLOT_TOP} className="mx-auto mt-8 max-w-2xl" />

        {result && (
          <div className="mx-auto mt-10 max-w-2xl space-y-6">
            <section className="card p-6">
              <h2 className="font-semibold">Your ideal customer</h2>
              <p className="mt-2 text-sm text-slate-600">{result.criteria.audienceSummary}</p>

              <div className="mt-4 space-y-3 text-sm">
                <div>
                  <p className="font-medium text-slate-700">Business types</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {result.criteria.businessTypes.map((t) => (
                      <span key={t} className="chip">{t}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="font-medium text-slate-700">What to look for</p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-slate-600">
                    {result.criteria.buyingSignals.map((s) => <li key={s}>{s}</li>)}
                  </ul>
                </div>
                <div>
                  <p className="font-medium text-slate-700">Skip businesses that</p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-slate-600">
                    {result.criteria.disqualifiers.map((s) => <li key={s}>{s}</li>)}
                  </ul>
                </div>
              </div>
            </section>

            <AdSlot slot={import.meta.env.VITE_ADSENSE_SLOT_MID} />

            <section className="card p-6">
              <h2 className="font-semibold">Businesses that match</h2>
              {result.sample.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">
                  No listings came back for this one. Try naming a specific city.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100">
                  {result.sample.map((b, i) => (
                    <li key={i} className="py-3">
                      <p className="font-medium">{b.name}</p>
                      <p className="text-sm text-slate-500">
                        {[b.category, b.address].filter(Boolean).join(' · ')}
                        {b.rating ? ` · ${b.rating}★ (${b.reviewCount || 0})` : ''}
                      </p>
                      {b.websiteUrl && (
                        <a href={b.websiteUrl} target="_blank" rel="noreferrer noopener" className="link text-sm">
                          {b.websiteUrl.replace(/^https?:\/\//, '').slice(0, 50)} ↗
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-5 rounded-lg bg-slate-50 p-4">
                <p className="text-sm font-medium">This is a small sample.</p>
                <p className="mt-1 text-sm text-slate-600">
                  A free account runs the full search, finds each business's published contact address, and
                  drafts a personalised email for you to review before anything is sent.
                </p>
                <Link to="/register" className="btn-primary mt-3">Create a free account</Link>
              </div>
            </section>
          </div>
        )}

        <AdSlot slot={import.meta.env.VITE_ADSENSE_SLOT_BOTTOM} className="mx-auto mt-10 max-w-2xl" />
      </main>

      <footer className="mt-12 border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-8 text-sm text-slate-500">
          <p>
            Reachlist finds businesses from public listings and reads contact addresses only from the pages
            those businesses publish themselves. Nothing is sent without your approval, every unsubscribe is
            honoured permanently, and in regions that require prior consent it will only ever write to a
            company's own published inbox — never to a named individual.
          </p>
        </div>
      </footer>
    </div>
  );
}
