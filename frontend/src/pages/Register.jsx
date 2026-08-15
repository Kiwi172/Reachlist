import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { errText } from '../api/client.js';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await register(form.email, form.password, form.name);
      navigate('/dashboard');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm px-4 py-20">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Create account</h1>
      <p className="mb-6 text-sm text-slate-500">Reachlist</p>
      <form onSubmit={submit} className="card space-y-4 p-6">
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div>
          <label className="label">Your name</label>
          <input className="input-field" value={form.name} onChange={set('name')} placeholder="Used as the sender name" />
        </div>
        <div>
          <label className="label">Email</label>
          <input className="input-field" type="email" value={form.email} onChange={set('email')} required />
        </div>
        <div>
          <label className="label">Password</label>
          <input className="input-field" type="password" value={form.password} onChange={set('password')} required minLength={10} />
          <p className="mt-1 text-xs text-slate-500">At least 10 characters.</p>
        </div>
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-500">
        Already have one? <Link to="/login" className="link">Sign in</Link>
      </p>
    </div>
  );
}
