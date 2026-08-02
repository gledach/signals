// Storage keys used in chrome.storage.sync / local
export const STORAGE = {
  apiUrl: 'signal.apiUrl',
  pollMin: 'signal.pollMin',
  notifThreshold: 'signal.notifThreshold',
  lastSeenTime: 'signal.lastSeenTime',
  pendingClip: 'signal.pendingClip',
  aiEnabled: 'signal.aiEnabled',
};

export const DEFAULT_POLL_MIN = 5;
export const DEFAULT_NOTIF_THRESHOLD = 80; // critical only

export const IMPACT_COLORS = {
  critical: '#ff5a5a',
  high: '#ff9a4d',
  medium: '#e0a93a',
  low: '#45c66a',
  noise: '#6e7681',
  convergence: '#d946ef',
};

export const SIGNAL_TYPES = [
  'product_launch',
  'pricing_change',
  'funding',
  'mna',
  'partnership',
  'customer_win',
  'exec_hire',
  'hiring_signal',
  'layoff',
  'review_praise',
  'review_complaint',
  'analyst_mention',
  'security_incident',
  'press_release',
  'sitemap_new_path',
  'robots_rule_change',
  'new_subdomain',
  'trend_spike',
  'trend_alternative_spike',
  'convergence',
  'noise',
  'other',
];

export function impactBand(score) {
  if (score >= 80) return 'critical';
  if (score >= 65) return 'high';
  if (score >= 45) return 'medium';
  if (score >= 25) return 'low';
  return 'noise';
}

export function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
