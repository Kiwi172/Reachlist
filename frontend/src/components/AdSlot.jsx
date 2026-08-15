import { useEffect, useRef } from 'react';

const CLIENT = import.meta.env.VITE_ADSENSE_CLIENT;

/**
 * A single display-ad unit.
 *
 * Renders a labelled placeholder until VITE_ADSENSE_CLIENT is set, so the
 * layout is honest during development and nothing calls out to an ad
 * network on a page that has no approved inventory yet.
 *
 * Note that AdSense requires the site to have real content and to be
 * approved before ads serve — an empty tool page will be rejected. The
 * placeholder is what you ship until that approval lands.
 */
export default function AdSlot({ slot, format = 'auto', className = '' }) {
  const ref = useRef(null);
  const pushed = useRef(false);

  useEffect(() => {
    if (!CLIENT || !slot || pushed.current) return;
    // Guard against StrictMode's double-invoke, which otherwise throws
    // "All ins elements already have ads in them".
    pushed.current = true;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      /* ad blocker or script not loaded — non-fatal */
    }
  }, [slot]);

  if (!CLIENT || !slot) {
    return (
      <div
        className={`flex min-h-24 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white text-xs uppercase tracking-wide text-slate-400 ${className}`}
      >
        Ad slot
      </div>
    );
  }

  return (
    <div className={className}>
      <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">Advertisement</p>
      <ins
        ref={ref}
        className="adsbygoogle block"
        data-ad-client={CLIENT}
        data-ad-slot={slot}
        data-ad-format={format}
        data-full-width-responsive="true"
      />
    </div>
  );
}
