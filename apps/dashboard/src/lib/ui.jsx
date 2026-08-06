/* Shared visual conventions — one place, all five tabs.
   Restraint rules: emerald is the single accent (primary action, active nav,
   good/resolved state); severity/status always renders as dot + word, never
   colour alone; money and ids are mono with tabular figures. */

export function Card({ children, className = '' }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function CardHeader({ title, subtitle, right }) {
  return (
    <div className="card-header">
      <div>
        <h2 className="card-header-title">{title}</h2>
        {subtitle && <p className="card-header-subtitle">{subtitle}</p>}
      </div>
      {right && <div className="card-header-right">{right}</div>}
    </div>
  );
}

export function CardBody({ children, className = '' }) {
  return <div className={`card-body ${className}`}>{children}</div>;
}

export function StatTile({ label, value, caption, tone }) {
  const valueColor = tone === 'good' ? 'var(--emerald)' : tone === 'bad' ? 'var(--red)' : 'var(--text-primary)';
  return (
    <div className="stat-tile">
      <div className="stat-tile-label">{label}</div>
      <div className="stat-tile-value" style={{ color: valueColor }}>
        {value}
      </div>
      {caption && <div className="stat-tile-caption">{caption}</div>}
    </div>
  );
}

/* ---- status & severity ---- */

const SEVERITY_DOT = {
  critical: '#f87171',
  high: '#fb923c',
  medium: '#fcd34d',
  low: '#64748b',
};

export function SeverityLabel({ severity }) {
  return (
    <span className="label-row">
      <span className="dot" style={{ background: SEVERITY_DOT[severity] ?? '#64748b' }} />
      <span className="label-text" style={{ color: 'var(--text-tertiary)' }}>
        {severity}
      </span>
    </span>
  );
}

const STATUS_STYLE = {
  open: { dot: '#fcd34d', text: '#fcd34d' },
  auto_resolved: { dot: '#34d399', text: '#34d399' },
  resolved: { dot: '#34d399', text: '#6ee7b7' },
  ignored: { dot: '#64748b', text: '#94a3b8' },
};

export function StatusLabel({ status }) {
  const s = STATUS_STYLE[status] ?? { dot: '#64748b', text: '#94a3b8' };
  return (
    <span className="label-row">
      <span className="dot" style={{ background: s.dot }} />
      <span className="label-text" style={{ color: s.text }}>
        {status.replace('_', ' ')}
      </span>
    </span>
  );
}

const PAYMENT_STATE_STYLE = {
  succeeded: { dot: '#34d399', text: '#34d399' },
  failed: { dot: '#f87171', text: '#f87171' },
  inflight: { dot: '#fcd34d', text: '#fcd34d' },
  refund_pending: { dot: '#fcd34d', text: '#fcd34d' },
  refunded: { dot: '#94a3b8', text: '#cbd5e1' },
};

export function PaymentStateLabel({ state }) {
  const s = PAYMENT_STATE_STYLE[state] ?? { dot: '#64748b', text: '#94a3b8' };
  return (
    <span className="label-row">
      <span className="dot" style={{ background: s.dot }} />
      <span className="label-text" style={{ color: s.text }}>
        {state.replace('_', ' ')}
      </span>
    </span>
  );
}

/* Drift classes / transaction kinds — quiet rectangular tag, mono */
export function Tag({ children }) {
  return <span className="tag">{children}</span>;
}

/* ---- controls ---- */

export const btnPrimary = 'btn btn-primary';
export const btnSecondary = 'btn btn-secondary';
export const btnSmall = 'btn-small';
export const selectStyle = 'select';

/* ---- table conventions ---- */

export const th = '';
export const thRight = 'right';

export function EmptyState({ children }) {
  return <p className="empty-state">{children}</p>;
}

export function LoadingState() {
  return <p className="loading-state">Loading…</p>;
}

export function ErrorState({ message }) {
  return <p className="error-state">{message}</p>;
}
