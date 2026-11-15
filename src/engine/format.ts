import type { Resource } from '../data/types';

export function fmtDuration(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

export function fmtNum(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(n);
}

export const RESOURCE_LABEL: Record<Resource, string> = {
  gold: 'gold',
  elixir: 'elixir',
  darkElixir: 'DE',
  goldOrElixir: 'gold or elixir',
  shinyOre: 'shiny ore',
  glowyOre: 'glowy ore',
  starryOre: 'starry ore',
};

export function fmtCost(cost: number, r: Resource): string {
  return `${fmtNum(cost)} ${RESOURCE_LABEL[r]}`;
}

/** Local clock time like "11:40 PM", with a weekday prefix if not today relative to `ref`. */
export function fmtClock(unixSec: number, refUnixSec?: number): string {
  const d = new Date(unixSec * 1000);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (refUnixSec === undefined) return time;
  const ref = new Date(refUnixSec * 1000);
  if (d.toDateString() === ref.toDateString()) return time;
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}
