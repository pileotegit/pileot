// Google Business Profile: Bewertungen eines Standorts lesen (Workflow D).
// Zugriff erfordert eine freigegebene Business Profile API (manueller Antrag bei Google) und
// ein OAuth-Refresh-Token mit Scope https://www.googleapis.com/auth/business.manage.
// Gespeichert werden nur Sterne, Zeitstempel und ob Text/Antwort vorhanden sind.

import type { Deps } from './types.ts';

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const MAX_PAGES = 20;

export type NormalizedReview = {
  review_id: string;
  star_rating: number | null;
  has_comment: boolean;
  has_reply: boolean;
  created_at: string;
  updated_at: string;
};

export function normalizeReview(r: any): NormalizedReview | null {
  const id = typeof r?.reviewId === 'string' ? r.reviewId : typeof r?.name === 'string' ? r.name.split('/').pop() : null;
  if (!id || typeof r?.createTime !== 'string') return null;
  return {
    review_id: id,
    star_rating: STARS[r.starRating] ?? null,
    has_comment: typeof r.comment === 'string' && r.comment.trim().length > 0,
    has_reply: !!r.reviewReply,
    created_at: r.createTime,
    updated_at: typeof r.updateTime === 'string' ? r.updateTime : r.createTime,
  };
}

export function googleConfigured(deps: Deps): boolean {
  const e = deps.env;
  return !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && e.GOOGLE_REFRESH_TOKEN);
}

export async function accessToken(deps: Deps): Promise<string> {
  const res = await deps.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: deps.env.GOOGLE_CLIENT_ID!,
      client_secret: deps.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: deps.env.GOOGLE_REFRESH_TOKEN!,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok || typeof data?.access_token !== 'string') {
    throw new Error(`oauth ${res.status} ${data?.error ?? ''}`.trim());
  }
  return data.access_token;
}

/**
 * Liest Bewertungen, neueste Änderung zuerst. Bei vorhandenem letzten Abgleich wird abgebrochen,
 * sobald Einträge älter als (letzter Abgleich minus 2 Tage) sind. Erster Abgleich: alle Seiten
 * bis MAX_PAGES.
 */
export async function fetchReviews(
  deps: Deps,
  token: string,
  googleLocationId: string,
  lastSyncAt: string | null,
): Promise<NormalizedReview[]> {
  const cutoff = lastSyncAt ? Date.parse(lastSyncAt) - 2 * 86400e3 : null;
  const out: NormalizedReview[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const u = new URL(`https://mybusiness.googleapis.com/v4/${googleLocationId}/reviews`);
    u.searchParams.set('pageSize', '50');
    u.searchParams.set('orderBy', 'updateTime desc');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const res = await deps.fetch(u.toString(), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`reviews ${res.status} ${data?.error?.status ?? ''}`.trim());
    let reachedCutoff = false;
    for (const r of data?.reviews ?? []) {
      const n = normalizeReview(r);
      if (!n) continue;
      if (cutoff !== null && Date.parse(n.updated_at) < cutoff) {
        reachedCutoff = true;
        break;
      }
      out.push(n);
    }
    pageToken = data?.nextPageToken;
    if (reachedCutoff || !pageToken) break;
  }
  return out;
}
