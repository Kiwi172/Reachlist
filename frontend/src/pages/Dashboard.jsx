import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errText } from '../api/client.js';

const STATUS_STYLES = {
  draft: 'bg-slate-100 text-slate-700',
  discovering: 'bg-blue-50 text-blue-700',
  ready: 'bg-brand-teal-light text-brand-teal-dark',
  sending: 'bg-amber-50 text-amber-700',
  paused: 'bg-red-50 text-red-700',
  done: 'bg-slate-100 text-slate-500',
};

export default function Dashboard() {
  const [products, setProducts] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState({ name: '', description: '', websiteUrl: '' });
  const [launch, setLaunch] = useState({ productId: '', locationHint: '' });

  const load = async () => {
    try {
      const [p, c] = await Promise.all([api.get('/api/products'), api.get('/api/campaigns')]);
      setProducts(p.data.products);
      setCampaigns(c.data.campaigns);
      if (!launch.productId && p.data.products[0]) {
        setLaunch((l) => ({ ...l, productId: p.data.products[0].id }));
      }
    } catch (err) {
      setError(errText(err));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const addProduct = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/products', product);
      setProduct({ name: '', description: '', websiteUrl: '' });
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const startCampaign = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/campaigns', launch);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
      {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      <section>
        <h1 className="text-xl font-semibold tracking-tight">Campaigns</h1>
        <p className="mt-1 text-sm text-slate-500">
          Each campaign targets one product. Nothing is sent until you approve it.
        </p>

        <div className="mt-4 space-y-2">
          {campaigns.length === 0 && (
            <p className="card p-6 text-sm text-slate-500">No campaigns yet — add a product below, then start one.</p>
          )}
          {campaigns.map((c) => (
            <Link key={c.id} to={`/campaigns/${c.id}`} className="card flex items-center justify-between p-4 transition hover:border-brand-teal">
              <div className="min-w-0">
                <p className="truncate font-medium">{c.name}</p>
                <p className="mt-0.5 text-sm text-slate-500">
                  {c.product.name} · {c._count.prospects} prospects · {c._count.sends} sent
                </p>
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[c.status] || 'bg-slate-100'}`}>
                {c.status}
              </span>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="card p-6">
          <h2 className="font-semibold">Add a product</h2>
          <p className="mt-1 text-sm text-slate-500">
            The description is the only thing the AI sees when building your targeting. Be specific about
            the problem it solves and who already pays for it.
          </p>
          <form onSubmit={addProduct} className="mt-4 space-y-3">
            <input
              className="input-field"
              placeholder="Product name"
              value={product.name}
              onChange={(e) => setProduct({ ...product, name: e.target.value })}
              required
            />
            <textarea
              className="input-field min-h-32"
              placeholder="What it does, what problem it solves, and what kind of business buys it."
              value={product.description}
              onChange={(e) => setProduct({ ...product, description: e.target.value })}
              required
              minLength={30}
            />
            <input
              className="input-field"
              placeholder="Website (optional)"
              value={product.websiteUrl}
              onChange={(e) => setProduct({ ...product, websiteUrl: e.target.value })}
            />
            <button className="btn-primary w-full" disabled={busy}>
              Save product
            </button>
          </form>
        </section>

        <section className="card p-6">
          <h2 className="font-semibold">Start a campaign</h2>
          <p className="mt-1 text-sm text-slate-500">
            The AI proposes targeting criteria, which you review and edit before anything runs.
          </p>
          <form onSubmit={startCampaign} className="mt-4 space-y-3">
            <select
              className="input-field"
              value={launch.productId}
              onChange={(e) => setLaunch({ ...launch, productId: e.target.value })}
              required
            >
              <option value="">Choose a product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <input
              className="input-field"
              placeholder="Where? e.g. Manchester, UK (optional)"
              value={launch.locationHint}
              onChange={(e) => setLaunch({ ...launch, locationHint: e.target.value })}
            />
            <button className="btn-primary w-full" disabled={busy || !launch.productId}>
              {busy ? 'Generating criteria…' : 'Generate criteria'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
