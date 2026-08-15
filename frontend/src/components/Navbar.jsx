import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link to="/dashboard" className="text-lg font-semibold tracking-tight text-brand-teal">
          Reachlist
        </Link>
        <div className="flex items-center gap-4">
          <span className="hidden text-sm text-slate-500 sm:inline">{user?.email}</span>
          <button
            className="btn-secondary py-1.5"
            onClick={() => {
              logout();
              navigate('/');
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
