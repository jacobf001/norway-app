import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Types ──────────────────────────────────────────────────────────────────

type LineupPlayer = { nff_player_id: string; name: string; shirt_no: number | null };
type TeamLineup   = { starters: LineupPlayer[]; bench: LineupPlayer[] };

type NormalizedSeasonRow = {
  season_year:        number;
  nff_team_id:        string | null;
  nff_player_id:      string | null;
  nff_competition_id: string | null;
  player_name:        string | null;
  team_name:          string | null;
  tier:               number | null;
  gender:             string | null;
  appearances:        number;
  starts:             number;
  minutes:            number;
  goals:              number;
  yellow_cards:       number;
  red_cards:          number;
};

type TableRow = {
  nff_competition_id: string | null;
  nff_season_id:      string | null;
  season_year:        number;
  nff_team_id:        string | null;
  team_name:          string | null;
  tier:               number | null;
  gender:             string | null;
  competition_name:   string | null;
  played:             number;
  wins:               number;
  draws:              number;
  losses:             number;
  goals_for:          number;
  goals_against:      number;
  goal_diff:          number;
  points:             number;
  position:           number | null;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
function clamp(x: number, lo: number, hi: number) {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}
function sigmoid(x: number) { return 1 / (1 + Math.exp(-x)); }

function uniqById(xs: LineupPlayer[]) {
  const seen = new Set<string>();
  return xs.filter(x => {
    const id = String(x.nff_player_id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function normalizeSeasonRows(rows: any[]): NormalizedSeasonRow[] {
  return (rows ?? []).map(r => ({
    season_year:        Number(r.season_year),
    nff_team_id:        r.nff_team_id != null ? String(r.nff_team_id) : null,
    nff_player_id:      r.nff_player_id != null ? String(r.nff_player_id) : null,
    nff_competition_id: r.nff_competition_id != null ? String(r.nff_competition_id) : null,
    player_name:        r.player_name ?? null,
    team_name:          r.team_name ?? null,
    tier:               Number.isFinite(Number(r.tier)) ? Number(r.tier) : null,
    gender:             r.gender ?? null,
    appearances:        Number(r.appearances ?? 0),
    starts:             Number(r.starts ?? 0),
    minutes:            Number(r.minutes ?? 0),
    goals:              Number(r.goals ?? 0),
    yellow_cards:       Number(r.yellow_cards ?? 0),
    red_cards:          Number(r.red_cards ?? 0),
  }));
}

function cleanTeamName(name: string | null, tier: number | null): string | null {
  if (!name) return null;
  if (tier != null && tier <= 2 && name.endsWith(" 2")) {
    return name.slice(0, -2).trim();
  }
  return name;
}

// ── Tier / quality helpers ─────────────────────────────────────────────────

function isWomenGender(gender: string | null | undefined): boolean {
  if (!gender) return false;
  const g = gender.toLowerCase();
  return g === "female" || g === "youth_female";
}

function tierBaseCeiling(tier: number, women: boolean): number {
  if (women) {
    if (tier <= 1) return 92; if (tier === 2) return 78;
    if (tier === 3) return 50; if (tier === 4) return 36; return 28;
  }
  if (tier <= 1) return 92; if (tier === 2) return 78;
  if (tier === 3) return 64; if (tier === 4) return 55;
  if (tier === 5) return 45; if (tier === 6) return 36; return 28;
}

function maxGamesForTier(tier: number, women: boolean): number {
  if (women) { if (tier <= 2) return 22; return 16; }
  if (tier <= 1) return 30; if (tier === 2) return 30;
  if (tier === 3) return 26; if (tier === 4) return 26;
  if (tier === 5) return 26; return 22;
}

function tierScale(tier: number, women: boolean): number {
  if (tier <= 1) return 1.0;
  if (women) {
    if (tier === 2) return 0.25; if (tier === 3) return 0.08;
    if (tier === 4) return 0.04; return 0.02;
  }
  if (tier === 2) return 0.78; if (tier === 3) return 0.58;
  if (tier === 4) return 0.43; if (tier === 5) return 0.32;
  if (tier === 6) return 0.22; return 0.15;
}

function tierQuality(tier: number, women: boolean): number {
  return tierScale(tier, women);
}

function isYouthTier(tier: number | null): boolean {
  return tier != null && tier >= 6 && tier <= 8;
}

// ── Importance ─────────────────────────────────────────────────────────────

function calcImportance(params: {
  minutes: number; starts: number; goals: number;
  yellows: number; reds: number; maxGames: number; ceiling: number;
}): number {
  const maxMins = params.maxGames * 90;
  const minutesN = clamp01(params.minutes / Math.max(1, maxMins));
  const startsN = clamp01(params.starts / Math.max(1, params.maxGames));
  const minsPerGame = params.maxGames > 0 ? params.minutes / params.maxGames : 0;

  // Use whichever is higher — starts ratio or minutes-per-game ratio (out of 90)
  const participationN = Math.max(startsN, clamp01(minsPerGame / 90));
  const startsDominant = participationN >= 0.60
    ? Math.min(participationN * 1.1, 1.0)
    : participationN;

  const goalsBoost = clamp01(params.goals / 10) * 0.20;
  const cardPenalty = clamp01(params.yellows * 0.02 + params.reds * 0.08);

  const raw = minutesN * 0.50 + startsDominant * 0.45 + goalsBoost - cardPenalty;
  return Math.min(Math.max(0, Math.round(raw * params.ceiling)), params.ceiling);
}

function pickBestTier(rows: NormalizedSeasonRow[]): { tier: number | null; women: boolean } {
  let bestTier = 99;
  let bestMins = 0;
  let women    = false;
  for (const r of rows) {
    if (r.tier && r.tier < 90 && r.minutes > bestMins) {
      bestMins = r.minutes;
      bestTier = r.tier;
      women    = isWomenGender(r.gender);
    }
  }
  return { tier: bestTier < 99 ? bestTier : null, women };
}

function calcWeightedImportance(rows: NormalizedSeasonRow[], seasonYearCtx: number): {
  importance: number; ceiling: number; tier: number | null; women: boolean;
} {
  // Filter out unused subs — rows with no minutes and no starts are meaningless
  const activeRows = rows.filter(r => Number(r.minutes ?? 0) > 0 || Number(r.starts ?? 0) > 0);
  if (!activeRows.length) return { importance: 0, ceiling: 100, tier: null, women: false };

  const { tier, women } = pickBestTier(activeRows);
  const ceiling  = tier ? tierBaseCeiling(tier, women) : 64;

  const tierMax  = tier ? maxGamesForTier(tier, women) : 22;
  const totalStarts = activeRows.reduce((s, r) => s + r.starts, 0);
  const maxGames = Math.min(Math.max(totalStarts, tierMax * 0.6), tierMax);

  const youthDiscount = tier && isYouthTier(tier) ? 0.5 : 1.0;
  const totalMins   = activeRows.reduce((s, r) => s + r.minutes,      0) * youthDiscount;
  const totalGoals  = activeRows.reduce((s, r) => s + r.goals,        0) * youthDiscount;
  const totalYellow = activeRows.reduce((s, r) => s + r.yellow_cards, 0);
  const totalRed    = activeRows.reduce((s, r) => s + r.red_cards,    0);

  const importance = calcImportance({
    minutes: totalMins, starts: totalStarts * youthDiscount, goals: totalGoals,
    yellows: totalYellow, reds: totalRed, maxGames, ceiling,
  });
  return { importance: Math.min(importance, ceiling), ceiling, tier, women };
}

function pickPreferredRows(
    rows: NormalizedSeasonRow[],
    teamId: string | null | undefined,
    compId: string | null | undefined,
    matchGender: string | null | undefined,
    matchTierHint?: number | null,
  ): NormalizedSeasonRow[] {
    if (!rows.length) return [];

    const genderRows = matchGender
      ? rows.filter(r => {
          if (!r.gender) return true;
          const rg = r.gender.toLowerCase();
          const mg = (matchGender ?? "").toLowerCase();
          if (mg === "male")   return rg === "male"   || rg === "youth_male";
          if (mg === "female") return rg === "female" || rg === "youth_female";
          return true;
        })
      : rows;

    const source = genderRows.length > 0 ? genderRows : rows;

    // Helper: given a set of rows for the same team, keep only the tier
    // where the player has the most minutes (their primary role)
    function keepPrimaryTier(teamRows: NormalizedSeasonRow[]): NormalizedSeasonRow[] {
      const minutesByTier = new Map<number, number>();
      for (const r of teamRows) {
        const t = r.tier ?? 99;
        minutesByTier.set(t, (minutesByTier.get(t) ?? 0) + r.minutes);
      }
      const primaryTier = Array.from(minutesByTier.entries())
        .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 99;
      return teamRows.filter(r => (r.tier ?? 99) === primaryTier);
    }

    // Remove the compId strict branch entirely, rely on tier instead
    if (teamId && matchTierHint) {
      const tierRows = source.filter(r =>
        String(r.nff_team_id ?? "") === String(teamId) && r.tier === matchTierHint
      );
      if (tierRows.length > 0) return keepPrimaryTier(tierRows).sort((a, b) => b.minutes - a.minutes);
    }

    if (teamId) {
      const teamRows = source.filter(r => String(r.nff_team_id ?? "") === String(teamId));
      if (teamRows.length > 0) return keepPrimaryTier(teamRows).sort((a, b) => b.minutes - a.minutes);
    }

    // No team match — group by team+tier, pick the group with most total minutes
    const groupMap = new Map<string, NormalizedSeasonRow[]>();
    for (const r of source) {
      const key = `${r.nff_team_id ?? "x"}_${r.tier ?? 99}`;
      const arr = groupMap.get(key) ?? [];
      arr.push(r);
      groupMap.set(key, arr);
    }

    const bestGroup = Array.from(groupMap.values())
      .sort((a, b) => {
        const minsA = a.reduce((s, r) => s + r.minutes, 0);
        const minsB = b.reduce((s, r) => s + r.minutes, 0);
        return minsB - minsA;
      })[0] ?? source;

    return bestGroup.sort((a, b) => b.minutes - a.minutes);
  }

  

// ── Team strength from computed_league_table ───────────────────────────────

function strengthFromTableRow(row: TableRow | null, women: boolean): {
  strength: number; tier: number | null; position: number | null; played: number; points: number; ppm: number;
} {
  if (!row) return { strength: 0.15, tier: null, position: null, played: 0, points: 0, ppm: 0 };
  const played   = Number(row.played   ?? 0);
  const points   = Number(row.points   ?? 0);
  const tier     = row.tier ?? null;
  const position = row.position ?? null;
  const ppm      = played > 0 ? points / played : 0;
  const base     = clamp01(ppm / 3);
  const scale    = tierScale(tier ?? 3, women);
  const leagueSize = tier && tier <= 2 ? 16 : tier === 3 ? 14 : 12;
  const posN     = position ? clamp01(1 - (position - 1) / Math.max(1, leagueSize - 1)) : 0.5;
  const posMul   = 0.75 + 0.4 * posN;
  return { strength: clamp01(base * scale * posMul), tier, position, played, points, ppm };
}

function blendStrength(cur: number, prev: number, played: number, tier: number | null): number {
  const TIER_PRIOR: Record<number, number> = { 1: 0.52, 2: 0.38, 3: 0.26, 4: 0.16, 5: 0.10 };
  const prior = TIER_PRIOR[tier ?? 3] ?? 0.22;
  
  const w = clamp01(played / 8);
  // When few games played, blend prev with tier prior rather than using prev raw
  const prevWeight = clamp01(1 - played / 4);
  const adjustedPrev = prev * (1 - prevWeight * 0.4) + prior * prevWeight * 0.4;
  
  const blended = w * cur + (1 - w) * adjustedPrev;
  
  const FLOORS:   Record<number, number> = { 1: 0.35, 2: 0.25, 3: 0.15, 4: 0.10, 5: 0.06 };
  const CEILINGS: Record<number, number> = { 1: 1.00, 2: 0.54, 3: 0.34, 4: 0.19, 5: 0.11 };
  const t       = tier ?? 3;
  const floor   = FLOORS[t] ?? 0.04;
  const ceiling = CEILINGS[t] ?? 1.0;
  return clamp01(Math.max(Math.min(blended, ceiling), floor));
}

function bestTableRow(rows: TableRow[], teamId: string | null, preferCompId?: string | null, preferTier?: number | null, gender?: string | null): TableRow | null {
  if (!teamId || !rows.length) return null;
  const teamRows = rows.filter(r => String(r.nff_team_id) === String(teamId));
  if (!teamRows.length) return null;
  const leagueRows = teamRows.filter(r => {
    if ((r.tier ?? 99) >= 9) return false;
    if (gender) {
      const rg = (r.gender ?? "").toLowerCase();
      const mg = gender.toLowerCase();
      if (mg === "youth_male" && rg !== "youth_male") return false;
      if (mg === "youth_female" && rg !== "youth_female") return false;
      if (mg === "male" && (rg === "female" || rg === "youth_male" || rg === "youth_female")) return false;
      if (mg === "female" && (rg === "male" || rg === "youth_male" || rg === "youth_female")) return false;
    }
    if (!gender && (r.gender === "Youth_Male" || r.gender === "Youth_Female")) return false;
    return true;
  });
  const source = leagueRows.length > 0 ? leagueRows : (gender ? [] : teamRows);
  if (preferCompId) {
    const compMatch = source.find(r => r.nff_competition_id === preferCompId);
    if (compMatch) return compMatch;
  }
  if (preferTier) {
    const tierMatch = source.find(r => r.tier === preferTier);
    if (tierMatch) return tierMatch;
  }
    // Instead of picking lowest tier, pick closest to preferTier
    return source.reduce((best, r) => {
    if (!best) return r;
    if (preferTier != null) {
      const bestDiff = Math.abs(Number(best.tier ?? 99) - preferTier);
      const rDiff = Math.abs(Number(r.tier ?? 99) - preferTier);
      if (rDiff < bestDiff) return r;
      if (rDiff === bestDiff && Number(r.played) > Number(best.played)) return r;
      return best;
    }
    const bestTier = Number(best.tier ?? 99);
    const rTier = Number(r.tier ?? 99);
    if (rTier < bestTier) return r;
    if (rTier === bestTier && Number(r.played) > Number(best.played)) return r;
    return best;
  }, null as TableRow | null);

}

function inferMatchTier(
  homeTeamId: string | null,
  awayTeamId: string | null,
  curSeasonRows: NormalizedSeasonRow[]
): number | null {
  const tiers: number[] = [];
  for (const r of curSeasonRows) {
    if (r.tier && r.tier < 9 && (r.nff_team_id === homeTeamId || r.nff_team_id === awayTeamId)) {
      tiers.push(r.tier);
    }
  }
  if (!tiers.length) return null;
  const counts = new Map<number, number>();
  for (const t of tiers) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
}

// ── Side rating ────────────────────────────────────────────────────────────

function sideRating(side: { starters: any[]; bench: any[] }, strength: number, missingImpact = 0) {
  const starterSum = side.starters.reduce((s, p) => s + Number(p.importance ?? 0), 0);
  const benchSum   = side.bench.reduce((s, p) => s + Number(p.importance ?? 0), 0);
  const presentAvg    = side.starters.length > 0 ? starterSum / side.starters.length : 0;
  const expectedTotal = starterSum + missingImpact;
  const missingRatio  = expectedTotal > 0 ? clamp01(missingImpact / expectedTotal) : 0;
  const avgStarterImp = clamp01((presentAvg / 100) * (1 - missingRatio));
  const lineupGap     = Math.max(0, strength - avgStarterImp);
  const lineupWeight  = clamp01(0.55 + lineupGap * 0.35);
  const histWeight    = 1 - lineupWeight;
  const cappedHist    = strength * (1 - missingRatio * 0.8);
  const effectiveStr  = clamp01(cappedHist * histWeight + avgStarterImp * lineupWeight);

  const avgCeiling   = side.starters.length > 0
    ? side.starters.reduce((s, p) => s + (p.importanceCeiling ?? 100), 0) / side.starters.length
    : 100;
  const avgImpRatio   = side.starters.length > 0 ? (starterSum / side.starters.length) / avgCeiling : 0;
  const untrackedPen  = clamp01(1 - avgImpRatio * 8);

  const raw    = starterSum + benchSum * 0.35;
  const scaled = raw * (0.75 + 0.55 * effectiveStr);
  const startersKnown = side.starters.filter(p => p.season != null).length;
  const coverage = side.starters.length ? startersKnown / side.starters.length : 0;
  const effectiveWithPenalty = effectiveStr * (1 - untrackedPen * 0.7);


  return {
    starters: Math.round(starterSum),
    bench:    Math.round(benchSum),
    raw:      Math.round(raw),
    total:    Math.round(scaled),
    coverage,
    effectiveStrength: Math.max(effectiveWithPenalty, strength * 0.3),
  };
}

function computeOverall(params: {
  teamStrength: number; tier: number | null; total: number;
  coverage: number; missingImpact: number; women: boolean;
}): number {
  const tierN     = clamp01(tierQuality(params.tier ?? 3, params.women));
  const strengthN = clamp01(params.teamStrength);
  const lineupN   = clamp01(params.total / 600);
  const coverageN = clamp01(params.coverage);
  const missingN  = clamp01(params.missingImpact / (tierBaseCeiling(params.tier ?? 3, params.women) * 4));
  return Math.round(clamp01(0.18 * tierN + 0.30 * strengthN + 0.42 * lineupN + 0.10 * coverageN - 0.12 * missingN) * 100);
}

// ── Odds model ─────────────────────────────────────────────────────────────


function computeOdds(params: {
  homeTier: number; awayTier: number;
  homeStrength: number; awayStrength: number;
  homeMissingImpact: number; awayMissingImpact: number;
  homeMissingGoals?: number; awayMissingGoals?: number;
  homePosition: number | null; awayPosition: number | null;
  homePlayed: number; awayPlayed: number;
  homeLineupTotal: number; awayLineupTotal: number;
  homeAvgCeiling: number; awayAvgCeiling: number;
  women: boolean;
  sameCompetition: boolean;
}) {
  const tierQualityHome = params.homeTier <= 1 ? 1.0 : params.homeTier === 2 ? 0.78 : params.homeTier === 3 ? 0.58 : params.homeTier === 4 ? 0.43 : 0.32;
  const tierQualityAway = params.awayTier <= 1 ? 1.0 : params.awayTier === 2 ? 0.78 : params.awayTier === 3 ? 0.58 : params.awayTier === 4 ? 0.43 : 0.32;

  const homeRatio = clamp((params.homeLineupTotal / (55 * 11)) * (params.homeAvgCeiling / 55), 0, 1.6) * tierQualityHome;
  const awayRatio = clamp((params.awayLineupTotal / (55 * 11)) * (params.awayAvgCeiling / 55), 0, 1.6) * tierQualityAway;
  const ceilingGap = (params.awayAvgCeiling - params.homeAvgCeiling) / 55;
  const tierDiff = Math.abs(params.homeTier - params.awayTier);
  const lineupZ = (homeRatio - awayRatio) * 2.0 + (tierDiff > 0 ? ceilingGap * 1.5 : 0);
  const strengthZ = clamp(params.homeStrength - params.awayStrength, -1, 1) * 1.2;

  const MISS_CEILINGS: Record<number, number> = { 1: 92, 2: 78, 3: 64, 4: 55, 5: 45, 6: 36 };
  const homeMissN  = clamp(params.homeMissingImpact / ((MISS_CEILINGS[params.homeTier] ?? 50) * 7), 0, 1);
  const awayMissN  = clamp(params.awayMissingImpact / ((MISS_CEILINGS[params.awayTier] ?? 50) * 7), 0, 1);  
  const missingAdj = clamp((awayMissN - homeMissN) * 1.2, -1.0, 1.0) * 0.40;

  const isNewSeason = params.homePlayed <= 3 || params.awayPlayed <= 3;
  const playedWeight = isNewSeason 
    ? clamp01(Math.min(params.homePlayed, params.awayPlayed) / 6) * 0.3
    : clamp01(Math.min(params.homePlayed, params.awayPlayed) / 6);
  const posGap  = (params.awayPosition ?? 6) - (params.homePosition ?? 6);
  const tiersSame = params.homeTier === params.awayTier;
  const posZ    = tiersSame && params.sameCompetition ? clamp(posGap * 0.10, -0.7, 0.7) * playedWeight : 0;
  const tierGap = params.awayTier - params.homeTier;
  const tierAdv = clamp(tierGap * 0.45, -1.2, 1.2);
  const homeAdv = 0.16;

  const homeMissingGoalsZ = clamp((params.homeMissingGoals ?? 0) / 0.5, 0, 1.0);
  const awayMissingGoalsZ = clamp((params.awayMissingGoals ?? 0) / 0.5, 0, 1.0);
  const missingGoalsAdj = clamp((awayMissingGoalsZ - homeMissingGoalsZ) * 0.25, -0.3, 0.3);

  console.log("DEBUG z:", { lineupZ, strengthZ, tierAdv, posZ, missingAdj, missingGoalsAdj, homeAdv, ceilingGap });


  const z       = lineupZ + missingAdj + missingGoalsAdj + strengthZ + posZ + tierAdv + homeAdv;
  const pHomeR  = sigmoid(z);
  const gap     = Math.abs(z);
  const pDraw   = clamp(0.27 - 0.035 * gap, 0.16, 0.30);
  let pHome     = (1 - pDraw) * pHomeR;
  let pAway     = (1 - pDraw) * (1 - pHomeR);
  pHome = Math.min(pHome, 0.85);
  pAway = Math.max(pAway, 0.03);
  const sideTot = pHome + pAway;
  const target  = 1 - pDraw;
  if (sideTot > 0) { pHome = pHome / sideTot * target; pAway = pAway / sideTot * target; }

  console.log("DEBUG ratios:", { homeRatio, awayRatio, ceilingGap, lineupZ });

  return {
    probabilities: { home: pHome, draw: pDraw, away: pAway },
    odds: {
      home: pHome > 0 ? 1 / pHome : null,
      draw: pDraw > 0 ? 1 / pDraw : null,
      away: pAway > 0 ? 1 / pAway : null,
    },
  };
}

// ── Goals model ────────────────────────────────────────────────────────────

// Based on actual computed_league_table data (avg of 2024+2025 seasons)
// Format: [home_xG_baseline, away_xG_baseline] — home gets slight advantage
// Real Norwegian data from matches table (2024+2025 avg)
// Format: [avg_home_goals, avg_away_goals]
const TIER_GOAL_BASELINES: Record<number, [number, number]> = {
  1: [1.66, 1.35],  // M T1: (1.513+1.808)/2, (1.325+1.367)/2
  2: [1.70, 1.50],  // M T2: (1.733+1.658)/2, (1.458+1.538)/2
  3: [1.99, 1.50],  // M T3: (1.951+2.025)/2, (1.495+1.503)/2
  4: [2.38, 1.83],  // M T4: (2.299+2.463)/2, (1.815+1.848)/2
  5: [2.76, 2.14],  // M T5: (2.709+2.805)/2, (2.136+2.135)/2
  6: [2.98, 2.50],  // Youth Male T5: (2.984+2.975)/2, (2.395+2.609)/2
};

const TIER_GOAL_BASELINES_WOMEN: Record<number, [number, number]> = {
  1: [1.62, 1.37],  // F T1: (1.437+1.807)/2, (1.348+1.385)/2
  2: [1.67, 1.34],  // F T2: (1.530+1.811)/2, (1.282+1.402)/2
  3: [2.28, 1.69],  // F T3: (2.333+2.220)/2, (1.586+1.784)/2
  4: [2.86, 2.01],  // F T4: 2025 only
};

function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function computeGoals(params: {
  homeTier: number; awayTier: number;
  homeStrength: number; awayStrength: number;
  homeMissingGoals?: number; awayMissingGoals?: number;
  women: boolean;
}) {
  const baselines = params.women ? TIER_GOAL_BASELINES_WOMEN : TIER_GOAL_BASELINES;
  const hB = baselines[params.homeTier] ?? baselines[3] ?? TIER_GOAL_BASELINES[3];
  const aB = baselines[params.awayTier] ?? baselines[3] ?? TIER_GOAL_BASELINES[3];
  const TIER_AVG: Record<number, number> = { 1: 0.42, 2: 0.35, 3: 0.22, 4: 0.14, 5: 0.08, 6: 0.05 };
  const homeAvg = TIER_AVG[params.homeTier] ?? 0.18;
  const awayAvg = TIER_AVG[params.awayTier] ?? 0.18;
  let homeXG = hB[0] * clamp(1 + (params.homeStrength - homeAvg) * 1.5, 0.75, 1.5);
  let awayXG = aB[1] * clamp(1 + (params.awayStrength - awayAvg) * 1.5, 0.75, 1.5);

  homeXG = homeXG * (1 - clamp((params.homeMissingGoals ?? 0) / Math.max(0.01, hB[0] * 2), 0, 0.08));
  awayXG = awayXG * (1 - clamp((params.awayMissingGoals ?? 0) / Math.max(0.01, aB[1] * 2), 0, 0.08));   

  // Reduce xG based on missing goalscorers — cap at 20% reduction
  //if (params.homeMissingGoals) {
    //homeXG = homeXG * (1 - clamp(params.homeMissingGoals / Math.max(0.01, hB[0] * 2), 0, 0.10));
  //}
  //if (params.awayMissingGoals) {
    //awayXG = awayXG * (1 - clamp(params.awayMissingGoals / Math.max(0.01, aB[1] * 2), 0, 0.10));
  //}

  const MAX = 6;
  let p_over15 = 0, p_over25 = 0, p_over35 = 0, p_btts = 0, p_under25 = 0;
  for (let h = 0; h <= MAX; h++) {
    for (let a = 0; a <= MAX; a++) {
      const p = poissonPmf(homeXG, h) * poissonPmf(awayXG, a);
      const t = h + a;
      if (t > 1.5) p_over15 += p;
      if (t > 2.5) p_over25 += p;
      if (t > 3.5) p_over35 += p;
      if (h > 0 && a > 0) p_btts += p;
      if (t < 2.5) p_under25 += p;
    }
  }
  return {
    xG: { home: Math.round(homeXG * 100) / 100, away: Math.round(awayXG * 100) / 100 },
    expectedTotal: Math.round((homeXG + awayXG) * 10) / 10,
    markets: {
      over15:   { prob: p_over15,   odds: p_over15   > 0 ? 1 / p_over15   : null },
      over25:   { prob: p_over25,   odds: p_over25   > 0 ? 1 / p_over25   : null },
      over35:   { prob: p_over35,   odds: p_over35   > 0 ? 1 / p_over35   : null },
      under25:  { prob: p_under25,  odds: p_under25  > 0 ? 1 / p_under25  : null },
      btts_yes: { prob: p_btts,     odds: p_btts     > 0 ? 1 / p_btts     : null },
      btts_no:  { prob: 1 - p_btts, odds: 1 - p_btts > 0 ? 1 / (1 - p_btts) : null },
    },
  };
}

// ── Likely XI ──────────────────────────────────────────────────────────────

async function getLikelyXI(teamId: string, seasonYear: number, gender: string | null, competitionId?: string | null): Promise<string[]> {
  const prevYear = seasonYear - 1;
  const buildQuery = (year: number) => {
    let q = supabaseAdmin.from("player_season_to_date").select("nff_player_id, starts, minutes, gender")
      .eq("season_year", year).eq("nff_team_id", teamId).order("starts", { ascending: false }).limit(40);
    if (competitionId) q = q.eq("nff_competition_id", competitionId);
    return q;
  };
  const [{ data: cur }, { data: prev }] = await Promise.all([buildQuery(seasonYear), buildQuery(prevYear)]);
  
  // Filter by gender if known
  const filterGender = (rows: any[]) => {
    if (!gender) return rows;
    const mg = gender.toLowerCase();
    return rows.filter((r: any) => {
      const rg = (r.gender ?? "").toLowerCase();
      if (mg === "youth_male")   return rg === "youth_male";
      if (mg === "youth_female") return rg === "youth_female";
      if (mg === "male")   return rg === "male" || rg === "youth_male" || rg === "";
      if (mg === "female") return rg === "female" || rg === "youth_female";
      return true;
    });
  };
  // Also pass effectiveGender through — getLikelyXI receives gender param

  const curRows  = filterGender(cur  ?? []);
  const prevRows = filterGender(prev ?? []);

  const maxStartsCur  = curRows.length > 0 ? Math.max(...curRows.map((r: any) => r.starts ?? 0)) : 0;
  const seasonProgress = Math.min(1, maxStartsCur / 20);

  const prevById = new Map<string, any>();
  for (const r of prevRows) prevById.set(String(r.nff_player_id), r);

  const scores = new Map<string, { id: string; score: number }>();
  for (const r of curRows) {
    const id = String(r.nff_player_id);
    const curScore = (r.starts ?? 0) * 90 + (r.minutes ?? 0);
    const prev = prevById.get(id);
    const prevScore = prev ? (prev.starts ?? 0) * 90 + (prev.minutes ?? 0) : 0;
    const curWeight  = Math.min(1, seasonProgress + ((r.starts ?? 0) / 15) * 0.5);
    const prevWeight = (1 - curWeight) * 0.6;
    scores.set(id, { id, score: curScore * curWeight + prevScore * prevWeight });
  }
  for (const r of prevRows) {
    const id = String(r.nff_player_id);
    if (scores.has(id)) continue;
    if ((r.starts ?? 0) < 8) continue;
    scores.set(id, { id, score: ((r.starts ?? 0) * 90 + (r.minutes ?? 0)) * (0.5 - seasonProgress * 0.35) });
  }

  return Array.from(scores.values())
    .filter(x => x.score >= 450)
    .sort((a, b) => b.score - a.score)
    .slice(0, 11)
    .map(x => x.id);
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const inputUrl = searchParams.get("url");
    if (!inputUrl) return NextResponse.json({ error: "Missing url param" }, { status: 400 });

    const seasonYearParam = searchParams.get("season");
    const currentYear     = new Date().getFullYear();

    // ── Step 1: Fetch lineups from match page ──────────────────────────────
    const origin     = new URL(req.url).origin;
    const lineupRes  = await fetch(`${origin}/api/lineups-from-report?url=${encodeURIComponent(inputUrl)}`, { cache: "no-store" });
    if (!lineupRes.ok) {
      const txt = await lineupRes.text();
      return NextResponse.json({ error: `lineups-from-report failed: ${txt}` }, { status: 500 });
    }
    const lineupJson = await lineupRes.json();
    if (lineupJson.error) return NextResponse.json({ error: lineupJson.error }, { status: 400 });

    const seasonYear     = seasonYearParam ? parseInt(seasonYearParam) : lineupJson.match?.season_year ?? currentYear;
    const prevSeasonYear = seasonYear - 1;

    const teams      = lineupJson.teams ?? { home: { nff_team_id: null, team_name: null }, away: { nff_team_id: null, team_name: null } };
    const matchComp  = lineupJson.match?.competition ?? null;
    const matchGender = matchComp?.gender ?? null;
    const matchTier   = matchComp?.tier   ?? null;
    console.log("DEBUG matchComp:", JSON.stringify(matchComp, null, 2));
    const isWomen     = isWomenGender(matchGender);

    const homeTeamId = teams.home.nff_team_id ? String(teams.home.nff_team_id) : null;
    const awayTeamId = teams.away.nff_team_id ? String(teams.away.nff_team_id) : null;
    const teamIds    = [homeTeamId, awayTeamId].filter(Boolean) as string[];

    const homePlayers = uniqById([...(lineupJson.home?.starters ?? []), ...(lineupJson.home?.bench ?? [])]);
    const awayPlayers = uniqById([...(lineupJson.away?.starters ?? []), ...(lineupJson.away?.bench ?? [])]);
    const allPlayers  = uniqById([...homePlayers, ...awayPlayers]);
    const allIds      = allPlayers.map(p => p.nff_player_id);

    if (!allIds.length) return NextResponse.json({ error: "No players found in lineup" }, { status: 400 });

    // ── Step 2: Fetch all data in parallel ────────────────────────────────
    const [
      { data: curSeasonRaw },
      { data: prevSeasonRaw },
      { data: curTableRaw },
      { data: prevTableRaw },
      { data: recentLineupRaw },
    ] = await Promise.all([
      supabaseAdmin.from("player_season_to_date").select("*").eq("season_year", seasonYear).in("nff_player_id", allIds),
      supabaseAdmin.from("player_season_to_date").select("*").eq("season_year", prevSeasonYear).in("nff_player_id", allIds),
      teamIds.length
        ? supabaseAdmin.from("computed_league_table").select("*").eq("season_year", seasonYear).in("nff_team_id", teamIds)
        : Promise.resolve({ data: [] }),
      teamIds.length
        ? supabaseAdmin.from("computed_league_table").select("*").eq("season_year", prevSeasonYear).in("nff_team_id", teamIds)
        : Promise.resolve({ data: [] }),
      supabaseAdmin.from("match_lineups")
        .select("nff_player_id, nff_match_id, nff_team_id, role, substituted_in, substituted_out")
        .in("nff_player_id", allIds),
    ]);

    const curSeasonRows  = normalizeSeasonRows(curSeasonRaw  ?? []);
    const prevSeasonRows = normalizeSeasonRows(prevSeasonRaw ?? []);

    // Index by player
    const curByPlayer  = new Map<string, NormalizedSeasonRow[]>();
    const prevByPlayer = new Map<string, NormalizedSeasonRow[]>();
    for (const r of curSeasonRows)  { const a = curByPlayer.get(r.nff_player_id!)  ?? []; a.push(r); curByPlayer.set(r.nff_player_id!, a); }
    for (const r of prevSeasonRows) { const a = prevByPlayer.get(r.nff_player_id!) ?? []; a.push(r); prevByPlayer.set(r.nff_player_id!, a); }

    // Team name map
    const teamNameById = new Map<string, string>();
    for (const r of [...curSeasonRows, ...prevSeasonRows]) {
      if (r.nff_team_id && r.team_name) teamNameById.set(r.nff_team_id, r.team_name);
    }

    // Collect all historical team IDs from player season rows (for position lookup)
    const allHistoricalTeamIds = Array.from(new Set([
      ...teamIds,
      ...curSeasonRows.map(r => r.nff_team_id).filter(Boolean),
      ...prevSeasonRows.map(r => r.nff_team_id).filter(Boolean),
    ])) as string[];

    // Fetch table data for all historical teams (beyond just home/away)
    const [{ data: allCurTableRaw }, { data: allPrevTableRaw }] = await Promise.all([
      allHistoricalTeamIds.length
        ? supabaseAdmin.from("computed_league_table").select("nff_team_id, season_year, position, competition_name, tier").eq("season_year", seasonYear).in("nff_team_id", allHistoricalTeamIds)
        : Promise.resolve({ data: [] }),
      allHistoricalTeamIds.length
        ? supabaseAdmin.from("computed_league_table").select("nff_team_id, season_year, position, competition_name, tier").eq("season_year", prevSeasonYear).in("nff_team_id", allHistoricalTeamIds)
        : Promise.resolve({ data: [] }),
    ]);

    // Recent appearances (last 5)
    const matchIds = Array.from(new Set((recentLineupRaw ?? []).map((r: any) => String(r.nff_match_id))));
    const kickoffMap = new Map<string, number>();
    if (matchIds.length) {
      const { data: matchKickoffs } = await supabaseAdmin
        .from("matches").select("nff_match_id, kickoff_at").in("nff_match_id", matchIds);
      for (const m of matchKickoffs ?? []) {
        const t = m.kickoff_at ? Date.parse(m.kickoff_at) : 0;
        kickoffMap.set(String(m.nff_match_id), Number.isFinite(t) ? t : 0);
      }
    }

    const recentByPlayer = new Map<string, Array<{ kickoff: number; role: string; sub_in: number | null; sub_out: number | null }>>();
    for (const r of recentLineupRaw ?? []) {
      const pid = String(r.nff_player_id);
      const mid = String(r.nff_match_id);
      const arr = recentByPlayer.get(pid) ?? [];
      arr.push({ kickoff: kickoffMap.get(mid) ?? 0, role: r.role ?? "starter", sub_in: r.substituted_in ?? null, sub_out: r.substituted_out ?? null });
      recentByPlayer.set(pid, arr);
    }

    function lastN(pid: string, n: number) {
      const arr = (recentByPlayer.get(pid) ?? []).sort((a, b) => b.kickoff - a.kickoff).slice(0, n);
      const mins = arr.reduce((s, r) => {
        if (r.sub_in !== null || r.sub_out !== null) {
          return s + Math.max(0, (r.sub_out ?? 90) - (r.sub_in ?? 0));
        }
        return s + (r.role === "starter" ? 90 : 30);
      }, 0);
      return { lastNApps: arr.length, lastNMinutes: mins, lastNStarts: arr.filter(r => r.role === "starter").length };
    }

    // ── Step 3: Team table rows ────────────────────────────────────────────
    const curTableRows  = (curTableRaw  ?? []) as unknown as TableRow[];
    const prevTableRows = (prevTableRaw ?? []) as unknown as TableRow[];

    const inferredTier = matchTier ?? inferMatchTier(homeTeamId, awayTeamId, curSeasonRows);

    // Build a position lookup keyed by team+year+competition
    const positionMap = new Map<string, { position: number | null; competition_name: string | null }>();
    for (const r of [...(curTableRaw ?? []), ...(prevTableRaw ?? []), ...(allCurTableRaw ?? []), ...(allPrevTableRaw ?? [])]) {
      if (!r.nff_team_id) continue;
      // Key by team+year+comp for accuracy, also store team+year for fallback
      const compKey = `${r.nff_team_id}_${r.season_year}_${(r as any).nff_competition_id ?? "x"}`;
      const fallbackKey = `${r.nff_team_id}_${r.season_year}`;
      const val = { position: (r as any).position ?? null, competition_name: (r as any).competition_name ?? null };
      positionMap.set(compKey, val);
      // Only set fallback if not already set (first/highest entry wins)
      if (!positionMap.has(fallbackKey)) positionMap.set(fallbackKey, val);
    }

    const compId = matchComp?.nff_competition_id ?? null;
    const homeCurTable  = bestTableRow(curTableRows,  homeTeamId, compId, inferredTier, matchGender);
    const awayCurTable  = bestTableRow(curTableRows,  awayTeamId, compId, inferredTier, matchGender);
    const homePrevTable = bestTableRow(prevTableRows, homeTeamId, compId, inferredTier, matchGender);
    const awayPrevTable = bestTableRow(prevTableRows, awayTeamId, compId, inferredTier, matchGender);

    // Infer gender from table rows if matchGender is null
    const inferredGender = matchGender
      ?? homeCurTable?.gender
      ?? awayCurTable?.gender
      ?? homePrevTable?.gender
      ?? awayPrevTable?.gender
      ?? null;
    const effectiveGender = inferredGender;
    const effectiveIsWomen = isWomenGender(effectiveGender);

    const homeCurStr  = strengthFromTableRow(homeCurTable,  effectiveIsWomen);
    const awayCurStr  = strengthFromTableRow(awayCurTable,  effectiveIsWomen);
    const homePrevStr = strengthFromTableRow(homePrevTable, effectiveIsWomen);
    const awayPrevStr = strengthFromTableRow(awayPrevTable, effectiveIsWomen);

    const homeTier = inferredTier ?? homeCurStr.tier ?? homePrevStr.tier ?? 3;
    const awayTier = inferredTier ?? awayCurStr.tier ?? awayPrevStr.tier ?? 3;

    // Display tier comes from actual table row, not match competition
    const homeDisplayTier = homeCurStr.tier ?? homePrevStr.tier ?? homeTier;
    const awayDisplayTier = awayCurStr.tier ?? awayPrevStr.tier ?? awayTier;

    const homeEffectivePlayed = homeCurStr.tier === homeTier ? homeCurStr.played : 0;
    const awayEffectivePlayed = awayCurStr.tier === awayTier ? awayCurStr.played : 0;

    const homeStrength = blendStrength(homeCurStr.strength, homePrevStr.strength, homeEffectivePlayed, homeTier);
    const awayStrength = blendStrength(awayCurStr.strength, awayPrevStr.strength, awayEffectivePlayed, awayTier);

    // ── Step 4: Enrich each player ─────────────────────────────────────────
    function enrich(p: LineupPlayer, side: "home" | "away") {
      const sideTeamId = side === "home" ? homeTeamId : awayTeamId;
      const sideCompId = side === "home"
        ? (homeCurTable?.nff_competition_id ?? null)
        : (awayCurTable?.nff_competition_id ?? null);
      const sideTier   = side === "home" ? homeTier : awayTier;

      const curRows  = curByPlayer.get(p.nff_player_id)  ?? [];
      const prevRows = prevByPlayer.get(p.nff_player_id) ?? [];

      const chosenCurRows  = pickPreferredRows(curRows,  sideTeamId, sideCompId, effectiveGender, sideTier);
      const chosenPrevRows = pickPreferredRows(prevRows, sideTeamId, sideCompId, effectiveGender, sideTier);

      const broadCurRows = curRows.filter(r => {
        if (!effectiveGender) return true;
        const rg = (r.gender ?? "").toLowerCase();
        const mg = effectiveGender.toLowerCase();
        if (mg === "male") return rg === "male" || rg === "youth_male" || rg === "";
        if (mg === "female") return rg === "female" || rg === "youth_female";
        return true;
      });

      const broadPrevRows  = pickPreferredRows(prevRows, null, null, effectiveGender);

      // Always use team-specific rows for importance calculation
      // Only fall back to broad if there are genuinely no team rows at all
      const broadBestTier = broadCurRows.length > 0 ? Math.min(...broadCurRows.map(r => r.tier ?? 99)) : 99;
      const chosenBestTier = chosenCurRows.length > 0 ? Math.min(...chosenCurRows.map(r => r.tier ?? 99)) : 99;
      const calcCurRows = (broadBestTier < chosenBestTier && broadBestTier < sideTier) ? broadCurRows : (chosenCurRows.length > 0 ? chosenCurRows : broadCurRows);
      const calcPrevRows = chosenPrevRows.length > 0 ? chosenPrevRows : broadPrevRows;

      const higherTierRows = broadCurRows.filter(r => {
        const t = r.tier ?? 99;
        if (t >= sideTier) return false;
        return r.minutes >= 450 || r.starts >= 5;
      });
      const currResult = higherTierRows.length > 0 
        ? calcWeightedImportance(higherTierRows, seasonYear) 
        : calcWeightedImportance(calcCurRows, seasonYear);
      const prevResult = calcPrevRows.length > 0 ? calcWeightedImportance(calcPrevRows, prevSeasonYear) : null;

      let importance        = 0;
      let importanceCeiling = currResult?.ceiling ?? prevResult?.ceiling ?? tierBaseCeiling(sideTier, effectiveIsWomen);

      if (currResult && prevResult) {
        const curEv      = calcCurRows.reduce((s, r) => s + r.minutes + r.starts * 90, 0);
        const prevWeight = Math.max(0, 1 - curEv / 500) * 0.3;
        importance = Math.round(currResult.importance * (1 - prevWeight) + prevResult.importance * prevWeight);
      } else if (currResult) {
        importance = currResult.importance;
      } else if (prevResult) {
        importance = prevResult.importance;
        importanceCeiling = prevResult.ceiling;
      }

      // Cap by side tier ceiling
      // Cap by side tier ceiling
      const sideCeiling = tierBaseCeiling(sideTier, effectiveIsWomen);
      // For youth matches, always cap at youth tier ceiling regardless of senior history
      const isYouthMatch = matchGender === "Youth_Male" || matchGender === "Youth_Female";
      const effectiveSideCeiling = isYouthMatch ? Math.min(sideCeiling, 45) : sideCeiling;
      importanceCeiling = Math.min(importanceCeiling, effectiveSideCeiling);
      importance        = Math.min(importance, importanceCeiling);

      // No current season evidence → cap at 10
      const allCurRows = [...(curByPlayer.get(p.nff_player_id) ?? [])];
      const hasCurEvidence = allCurRows.some(r => r.minutes > 0 || r.starts > 0);
      const hasPrevEvidence = calcPrevRows.some(r => r.minutes > 0 || r.starts > 0);
      if (!hasCurEvidence && !hasPrevEvidence) {
        importance = Math.round(sideCeiling * 0.25);
      } else if (!hasCurEvidence) {
        importance = Math.min(importance, 10);
      }

      // Find the player's highest proven tier (with sufficient evidence)
      const tierRowsForCap = ([...broadCurRows, ...broadPrevRows].filter(r => Number(r.minutes ?? 0) > 0 || Number(r.starts ?? 0) > 0).length > 0
        ? [...broadCurRows, ...broadPrevRows]
        : [...calcCurRows, ...calcPrevRows])
        .filter(r => Number(r.minutes ?? 0) > 0 || Number(r.starts ?? 0) > 0);

      const playerHighestTier = tierRowsForCap.reduce((best, r) => {
      const t = r.tier ?? 99;
      if (t >= 90) return best;
      const mins   = Number(r.minutes ?? 0);
      const starts = Number(r.starts ?? 0);
      const hasEvidence = mins >= 450 || (starts >= 5 && mins >= 200);
      return hasEvidence && t < best ? t : best;
    }, 99);

      const playerEvidenceScore = tierRowsForCap.reduce((sum, r) => {
        return sum + Number(r.minutes ?? 0) + Number(r.starts ?? 0) * 90;
      }, 0);

      if (sideTier < 99) {
        let effectiveCeiling = Math.min(sideCeiling, importanceCeiling);

        if (playerHighestTier < 99) {
          if (playerHighestTier < sideTier) {
            const higherTierEvidence = tierRowsForCap
              .filter(r => (r.tier ?? 99) < sideTier)
              .reduce((s, r) => s + r.minutes + r.starts * 90, 0);
            const higherTierRecentEvidence = [...broadCurRows]
              .filter(r => (r.tier ?? 99) < sideTier)
              .reduce((s, r) => s + r.minutes + r.starts * 90, 0);
            const recentActiveTier = [...broadCurRows]
              .filter(r => (r.tier ?? 99) < sideTier)
              .sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99))[0]?.tier ?? playerHighestTier;

            if (higherTierRecentEvidence >= 900) {
              effectiveCeiling = Math.max(sideCeiling, tierBaseCeiling(recentActiveTier, effectiveIsWomen));
              const boostRatio = sideCeiling / tierBaseCeiling(recentActiveTier, effectiveIsWomen);
              importance = Math.min(Math.round(importance / boostRatio), effectiveCeiling);
            } else if (higherTierEvidence >= 1800) {
              effectiveCeiling = Math.max(sideCeiling, Math.round(tierBaseCeiling(playerHighestTier, effectiveIsWomen) * 0.7));
            } else {
              effectiveCeiling = sideCeiling;
            }
          } else if (playerHighestTier === sideTier) {
            effectiveCeiling = Math.min(sideCeiling, importanceCeiling);
          } else {
            effectiveCeiling = Math.min(
              sideCeiling,
              tierBaseCeiling(playerHighestTier, effectiveIsWomen)
            );
          }
        }

        // Only clamp hard if evidence is poor
        if (playerEvidenceScore < 500) {
          effectiveCeiling = Math.min(effectiveCeiling, sideCeiling);
        }

        importanceCeiling = effectiveCeiling;
        importance = Math.min(importance, effectiveCeiling);

        // Position-gap discount: player is new to this team (no stats for current side)
        // but has stats for a same-tier club that finished much lower
        const hasEvidenceAtSide = [...calcCurRows, ...calcPrevRows].some(
          r => String(r.nff_team_id ?? "") === String(sideTeamId ?? "") && (r.minutes > 0 || r.starts > 0)
        );
        if (!hasEvidenceAtSide && playerHighestTier === sideTier && playerEvidenceScore >= 400) {
          const sidePosition = side === "home" ? homeCurStr.position : awayCurStr.position;
          // Find the position the player's best previous team finished
          const prevTeamId = tierRowsForCap
            .filter(r => r.tier === playerHighestTier)
            .sort((a, b) => b.minutes - a.minutes)[0]?.nff_team_id ?? null;
          const prevPosData = prevTeamId ? positionMap.get(`${prevTeamId}_${prevSeasonYear}`) ?? positionMap.get(`${prevTeamId}_${seasonYear}`) : null;
          const prevPos = prevPosData?.position ?? null;
          if (sidePosition && prevPos && prevPos > sidePosition + 3) {
            const posGap = prevPos - sidePosition;
            const posDiscount = posGap >= 8 ? 0.55 : posGap >= 6 ? 0.65 : posGap >= 4 ? 0.75 : 0.85;
            importance = Math.round(importance * posDiscount);
            importanceCeiling = Math.round(importanceCeiling * posDiscount);
          }
        }
      } // end if (sideTier < 99)

      // For youth matches, hard cap regardless of senior history
      if (matchGender === "Youth_Male" || matchGender === "Youth_Female") {
        const youthCap = tierBaseCeiling(sideTier, effectiveIsWomen);
        importanceCeiling = Math.min(importanceCeiling, youthCap);
        importance = Math.min(importance, importanceCeiling);
      }

      // Build seasons for expandable row — all competitions this player appeared in
      const allRows = [...curRows, ...prevRows].filter(r => r.tier && r.tier < 90);
      allRows.sort((a, b) => b.season_year - a.season_year || b.minutes - a.minutes);

      const seasonMap = new Map<string, NormalizedSeasonRow[]>();
      for (const r of allRows) {
        const key = `${r.season_year}_${r.nff_team_id}_${r.tier ?? "x"}`;
        const arr = seasonMap.get(key) ?? [];
        arr.push(r);
        seasonMap.set(key, arr);
      }

      const seasons = Array.from(seasonMap.entries())
        .sort(([ka, rowsA], [kb, rowsB]) => {
          const [ya] = ka.split("_");
          const [yb] = kb.split("_");
          if (yb !== ya) return parseInt(yb) - parseInt(ya);
          // Within same year, sort by total minutes descending (primary role first)
          const minsA = rowsA.reduce((s, r) => s + r.minutes, 0);
          const minsB = rowsB.reduce((s, r) => s + r.minutes, 0);
          return minsB - minsA;
        })
        .slice(0, 5)
        .map(([, rows], idx) => {
          const best = rows.reduce((a, b) => a.minutes >= b.minutes ? a : b);
          const imp  = calcWeightedImportance(rows, best.season_year);
          const isCurrentMain = idx === 0 && best.season_year === seasonYear;
          const posKey = best.nff_competition_id
            ? `${best.nff_team_id}_${best.season_year}_${best.nff_competition_id}`
            : `${best.nff_team_id}_${best.season_year}`;
          const posData = positionMap.get(posKey) ?? positionMap.get(`${best.nff_team_id}_${best.season_year}`) ?? null;
          return {
            season_year:  best.season_year,
            nff_team_id:  best.nff_team_id,
            team_name: cleanTeamName(
              best.team_name ?? (best.nff_team_id ? teamNameById.get(best.nff_team_id) ?? null : null),
              imp.tier
            ),
            appearances:  rows.reduce((s, r) => s + r.appearances, 0),
            starts:       rows.reduce((s, r) => s + r.starts, 0),
            minutes:      rows.reduce((s, r) => s + r.minutes, 0),
            goals:        rows.reduce((s, r) => s + r.goals, 0),
            yellow_cards: rows.reduce((s, r) => s + r.yellow_cards, 0),
            tier:         imp.tier,
            importance: isCurrentMain ? importance : Math.min(imp.importance, importanceCeiling),
            ceiling:    isCurrentMain ? importanceCeiling : Math.min(imp.ceiling, importanceCeiling),
            position:     posData?.position ?? null,
          };
        });

      // Best current season row for display in table
      // Use the first seasons entry for the headline stats so they match the dropdown
      const firstSeason = seasons[0] ?? null;

      if (p.name?.includes("Emin")) {
        console.log("DEBUG Emin:", {
          calcCurRows: calcCurRows.map(r => ({ team: r.nff_team_id, mins: r.minutes, starts: r.starts, tier: r.tier })),
          currResult,
          prevResult,
          importance,
          importanceCeiling,
        });
      }

      return {
        ...p,
        season:  firstSeason ? {
          season_year:  firstSeason.season_year,
          team_name:    firstSeason.team_name,
          appearances:  firstSeason.appearances,
          starts:       firstSeason.starts,
          minutes:      firstSeason.minutes,
          goals:        firstSeason.goals,
          tier:         firstSeason.tier,
        } : null,
        seasons,
        recent5: lastN(p.nff_player_id, 5),
        importance,
        importanceCeiling,
      };
    }

    const home = {
      starters: (lineupJson.home?.starters ?? []).map((p: LineupPlayer) => enrich(p, "home")),
      bench:    (lineupJson.home?.bench    ?? []).map((p: LineupPlayer) => enrich(p, "home")),
    };
    const away = {
      starters: (lineupJson.away?.starters ?? []).map((p: LineupPlayer) => enrich(p, "away")),
      bench:    (lineupJson.away?.bench    ?? []).map((p: LineupPlayer) => enrich(p, "away")),
    };

    // ── Step 5: Missing likely XI ──────────────────────────────────────────
    async function buildMissingXI(side: "home" | "away") {
      const teamId = side === "home" ? homeTeamId : awayTeamId;
      if (!teamId) return { missing: [], missingImpact: 0 };

      const sideCompId = side === "home"
        ? (homeCurTable?.nff_competition_id ?? compId)
        : (awayCurTable?.nff_competition_id ?? compId);
      // Only use competition ID if it matches the match gender
      const filteredCompId = sideCompId && matchGender
        ? (side === "home" ? homeCurTable?.gender : awayCurTable?.gender) === matchGender
          ? sideCompId
          : compId
        : sideCompId;
      const likelyXI = await getLikelyXI(teamId, seasonYear, effectiveGender, filteredCompId);
      const sideLineup = side === "home" ? home : away;
      const presentIds = new Set([
        ...sideLineup.starters.map((p: any) => p.nff_player_id),
        ...sideLineup.bench.map((p: any) => p.nff_player_id),
      ]);

      const missingIds = likelyXI.filter(id => !presentIds.has(id));
      if (!missingIds.length) return { missing: [], missingImpact: 0 };

      const [{ data: missRows }, { data: missPrevRows }] = await Promise.all([
        supabaseAdmin.from("player_season_to_date").select("*").eq("season_year", seasonYear).eq("nff_team_id", teamId).eq("nff_competition_id", sideCompId ?? "").in("nff_player_id", missingIds),
        supabaseAdmin.from("player_season_to_date").select("*").eq("season_year", prevSeasonYear).eq("nff_team_id", teamId).in("nff_player_id", missingIds),
      ]);

      const sideTier    = side === "home" ? homeTier : awayTier;
      const sideCeiling = tierBaseCeiling(sideTier, effectiveIsWomen);

      const missByPlayer = new Map<string, { rows: NormalizedSeasonRow[]; year: number }>();
      for (const r of normalizeSeasonRows(missRows ?? [])) {
        const existing = missByPlayer.get(r.nff_player_id!);
        if (existing) { existing.rows.push(r); } else { missByPlayer.set(r.nff_player_id!, { rows: [r], year: seasonYear }); }
      }
      for (const r of normalizeSeasonRows(missPrevRows ?? [])) {
        if (!missByPlayer.has(r.nff_player_id!)) {
          missByPlayer.set(r.nff_player_id!, { rows: [r], year: prevSeasonYear });
        }
      }

      const missing = Array.from(missByPlayer.entries()).map(([pid, { rows, year }]) => {
        const imp = calcWeightedImportance(rows, year);
        const best = rows.reduce((a, b) => a.minutes >= b.minutes ? a : b);
        return {
          nff_player_id:     pid,
          player_name:       best.player_name ?? null,
          starts:            rows.reduce((s, r) => s + r.starts, 0),
          minutes:           rows.reduce((s, r) => s + r.minutes, 0),
          goals:             rows.reduce((s, r) => s + r.goals, 0),
          importance:        Math.min(imp.importance, sideCeiling),
          importanceCeiling: Math.min(imp.ceiling, sideCeiling),
        };
      }).sort((a, b) => b.importance - a.importance);

      const missingImpact = missing.reduce((s, p) => s + p.importance, 0);
      return { missing, missingImpact };
    }

    const [homeMissing, awayMissing] = await Promise.all([
      buildMissingXI("home"),
      buildMissingXI("away"),
    ]);

    // ── Step 6: Compute ratings, odds, goals ───────────────────────────────
    const homeRating = sideRating(home, homeStrength, homeMissing.missingImpact);
    const awayRating = sideRating(away, awayStrength, awayMissing.missingImpact);

    const homeOverall = computeOverall({ teamStrength: homeRating.effectiveStrength, tier: homeTier, total: homeRating.total, coverage: homeRating.coverage, missingImpact: homeMissing.missingImpact, women: effectiveIsWomen });
    const awayOverall = computeOverall({ teamStrength: awayRating.effectiveStrength, tier: awayTier, total: awayRating.total, coverage: awayRating.coverage, missingImpact: awayMissing.missingImpact, women: effectiveIsWomen });

    // Calculate goals per game contributed by missing players
    const missingGoalsPerGame = (missing: any[], tier: number): number => {
      const maxG = maxGamesForTier(tier, effectiveIsWomen);
      return missing.reduce((s: number, p: any) => s + Number(p.goals ?? 0) / Math.max(1, maxG), 0);
    };
    const homeMissingGoals = missingGoalsPerGame(homeMissing.missing, homeTier);
    const awayMissingGoals = missingGoalsPerGame(awayMissing.missing, awayTier);

    const homeAvgCeiling = home.starters.length > 0
      ? home.starters.reduce((s: number, p: any) => s + (p.importanceCeiling ?? 55), 0) / home.starters.length
      : 55;
    const awayAvgCeiling = away.starters.length > 0
      ? away.starters.reduce((s: number, p: any) => s + (p.importanceCeiling ?? 55), 0) / away.starters.length
      : 55;
    const sameCompetition = homeCurTable?.nff_competition_id != null &&
      homeCurTable?.nff_competition_id === awayCurTable?.nff_competition_id;

    console.log("DEBUG ratings:", {
      homeLineupTotal: homeRating.total,
      awayLineupTotal: awayRating.total,
      homeEffStr: homeRating.effectiveStrength,
      awayEffStr: awayRating.effectiveStrength,
      homeStrength,
      awayStrength,
    });

    const pricing = computeOdds({
      homeTier: homeTier,
      awayTier: awayTier,
      homeStrength: homeRating.effectiveStrength,
      awayStrength: awayRating.effectiveStrength,
      homeMissingImpact: homeMissing.missingImpact,
      awayMissingImpact: awayMissing.missingImpact,
      homeMissingGoals,
      awayMissingGoals,
      homePosition: homeCurStr.position,
      awayPosition: awayCurStr.position,
      homePlayed:   homeCurStr.played,
      awayPlayed:   awayCurStr.played,
      homeLineupTotal: homeRating.total,
      awayLineupTotal: awayRating.total,
      homeAvgCeiling,
      awayAvgCeiling,
      women: effectiveIsWomen,
      sameCompetition,
    });

    console.log("DEBUG goals inputs:", {
      homeTier,
      awayTier,
      homeStrength: homeRating.effectiveStrength,
      awayStrength: awayRating.effectiveStrength,
      homeMissingGoals,
      awayMissingGoals,
    });

    const goalsModel = computeGoals({
      homeTier: homeTier,
      awayTier: awayTier,
      homeStrength: homeRating.effectiveStrength,
      awayStrength: awayRating.effectiveStrength,
      homeMissingGoals,
      awayMissingGoals,
      women: effectiveIsWomen,
    });

    // H2H from DB
    let h2h = null;
    if (homeTeamId && awayTeamId) {
      const { data: h2hRows } = await supabaseAdmin
        .from("matches")
        .select("nff_match_id, kickoff_at, home_team_nff_id, away_team_nff_id, home_score, away_score")
        .or(`and(home_team_nff_id.eq.${homeTeamId},away_team_nff_id.eq.${awayTeamId}),and(home_team_nff_id.eq.${awayTeamId},away_team_nff_id.eq.${homeTeamId})`)
        .order("kickoff_at", { ascending: false })
        .limit(10);
      
      if (h2hRows?.length) {
        const homeWins = h2hRows.filter(r => 
          (String(r.home_team_nff_id) === homeTeamId && r.home_score > r.away_score) ||
          (String(r.away_team_nff_id) === homeTeamId && r.away_score > r.home_score)
        ).length;
        const awayWins = h2hRows.filter(r =>
          (String(r.home_team_nff_id) === awayTeamId && r.home_score > r.away_score) ||
          (String(r.away_team_nff_id) === awayTeamId && r.away_score > r.home_score)
        ).length;
        const draws = h2hRows.filter(r => r.home_score === r.away_score).length;
        h2h = { played: h2hRows.length, homeWins, draws, awayWins, recent: h2hRows };
        console.log("DEBUG h2h:", JSON.stringify(h2h, null, 2));
      }
    }

    return NextResponse.json({
      inputUrl,
      season_year: seasonYear,
      teams,
      match: lineupJson.match,
      overall: { home: homeOverall, away: awayOverall },
      teamStrength: { home: homeRating.effectiveStrength, away: awayRating.effectiveStrength },
      teamStrengthDebug: {
        home: { tier: homeTier, strength: homeStrength, position: homeCurStr.position, played: homeCurStr.played, points: homeCurStr.points, ppm: homeCurStr.ppm, competition_name: matchComp?.name ?? homeCurTable?.competition_name ?? homePrevTable?.competition_name ?? null },
        away: { tier: awayTier, strength: awayStrength, position: awayCurStr.position, played: awayCurStr.played, points: awayCurStr.points, ppm: awayCurStr.ppm, competition_name: matchComp?.name ?? awayCurTable?.competition_name ?? awayPrevTable?.competition_name ?? null },
      },
      ...pricing,
      goals: goalsModel,
      home: { ...home, rating: homeRating, missingLikelyXI: homeMissing.missing, missingImpact: homeMissing.missingImpact },
      away: { ...away, rating: awayRating, missingLikelyXI: awayMissing.missing, missingImpact: awayMissing.missingImpact },
      h2h,
      model_version: "v2_norway",
    });

  } catch (e: any) {
    console.error("lineup-stats error:", e);
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}