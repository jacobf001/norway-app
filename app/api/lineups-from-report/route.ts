/**
 * /api/lineups-from-report
 *
 * Accepts a fotball.no match URL:
 *   https://www.fotball.no/fotballdata/kamp/?fiksId=8443747
 *
 * Scrapes the HTML to extract:
 *   - Home and away team names + nff_team_id (from club logo)
 *   - Starting XI and bench for both sides
 *   - Score and competition info from DB
 */

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { resolveTeamId } from "@/lib/teamIdMappings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "no,en;q=0.9",
    },
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#xF8;/g, "ø").replace(/&#xE6;/g, "æ").replace(/&#xE5;/g, "å")
    .replace(/&#xD8;/g, "Ø").replace(/&#xC6;/g, "Æ").replace(/&#xC5;/g, "Å")
    .replace(/&#xA0;/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&#x[0-9A-Fa-f]+;/g, "").replace(/&[a-z]+;/g, "").trim();
}

function extractTeamNames(html: string): [string | null, string | null] {
  const matches = [...html.matchAll(/<div class="teamName">\s*([^<]+?)\s*<\/div>/g)];
  const home = matches[0]?.[1] ? decodeHtmlEntities(matches[0][1]) : null;
  const away = matches[1]?.[1] ? decodeHtmlEntities(matches[1][1]) : null;
  return [home, away];
}

function extractTeamNamesWithIds(html: string): Array<{ name: string; clubId: string | null }> {
  const matches = [...html.matchAll(/<div class="teamName">\s*([^<]+?)\s*<\/div>/g)];
  const logos = [...html.matchAll(/clublogos\/(\d+)\.png/g)];
  return matches.map((m, i) => ({
    name: decodeHtmlEntities(m[1]),
    clubId: logos[i]?.[1] ?? null,
  }));
}

function extractClubIds(html: string): [string | null, string | null] {
  const matches = [...html.matchAll(/clublogos\/(\d+)\.png/g)];
  return [matches[0]?.[1] ?? null, matches[1]?.[1] ?? null];
}

function extractScore(html: string): { home: number | null; away: number | null; homeHt: number | null; awayHt: number | null } {
  const endM = html.match(/<div class="endResult">\s*(\d+)\s*-\s*(\d+)\s*<\/div>/);
  const htM  = html.match(/<div class="halfTime">\s*\(\s*(\d+)\s*-\s*(\d+)\s*\)\s*<\/div>/);
  return {
    home:   endM ? parseInt(endM[1]) : null,
    away:   endM ? parseInt(endM[2]) : null,
    homeHt: htM  ? parseInt(htM[1])  : null,
    awayHt: htM  ? parseInt(htM[2])  : null,
  };
}

function parseSide(html: string): Array<{ nff_player_id: string; name: string; shirt_no: number | null; role: "starter" | "substitute" }> {
  const players: Array<{ nff_player_id: string; name: string; shirt_no: number | null; role: "starter" | "substitute" }> = [];
  const subIdx = html.indexOf("Innbyttere");
  const starterHtml = subIdx !== -1 ? html.substring(0, subIdx) : html;
  const subHtml     = subIdx !== -1 ? html.substring(subIdx) : "";

  const parseSection = (sectionHtml: string, role: "starter" | "substitute") => {
    const items = sectionHtml.split('<div class="matchPlayerListItem">');
    for (const item of items.slice(1)) {
      const idM   = item.match(/\/fotballdata\/person\/profil\/\?fiksId=(\d+)/);
      if (!idM) continue;
      const nameM = item.match(/class="playerName"[^>]*>\s*([^<]+?)\s*<\/a>/);
      const shirtM = item.match(/<div class="playerNumber">\s*(\d+)\s*<\/div>/);
      const name = nameM ? decodeHtmlEntities(nameM[1]) : "";
      if (!players.find(p => p.nff_player_id === idM[1])) {
        players.push({
          nff_player_id: idM[1],
          name,
          shirt_no: shirtM ? parseInt(shirtM[1]) : null,
          role,
        });
      }
    }
  };

  parseSection(starterHtml, "starter");
  parseSection(subHtml, "substitute");
  return players;
}

function extractPlayers(html: string) {
  const homeStart = html.indexOf("homeTeamWrapper");
  const awayStart = html.indexOf("awayTeamWrapper");
  const homeHtml = homeStart !== -1 && awayStart !== -1 ? html.substring(homeStart, awayStart) : html;
  const awayHtml = awayStart !== -1 ? html.substring(awayStart) : "";
  return {
    home: parseSide(homeHtml),
    away: parseSide(awayHtml),
  };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const inputUrl = searchParams.get("url");
    if (!inputUrl) {
      return NextResponse.json({ error: "Missing url param" }, { status: 400 });
    }

    // Extract fiksId from URL
    const fiksMatch = inputUrl.match(/fiksId=(\d+)/);
    if (!fiksMatch) {
      return NextResponse.json({ error: "Could not find fiksId in URL" }, { status: 400 });
    }
    const fiksId = fiksMatch[1];

    // Fetch match page
    const matchUrl = `https://www.fotball.no/fotballdata/kamp/?fiksId=${fiksId}`;
    const html = await fetchHtml(matchUrl);

    const [homeName, awayName] = extractTeamNames(html);
    const [homeClubId, awayClubId] = extractClubIds(html);
    const score = extractScore(html);
    const { home: homePlayers, away: awayPlayers } = extractPlayers(html);

    // Look up match from DB for competition info and correct team IDs
    const { data: matchRow } = await supabaseAdmin
      .from("matches")
      .select("nff_match_id, nff_competition_id, season_year, home_score, away_score, kickoff_at, home_team_nff_id, away_team_nff_id")
      .eq("nff_match_id", fiksId)
      .maybeSingle();

    // Look up competition info
    let competition = null;
    if (matchRow?.nff_competition_id) {
      const { data: compRow } = await supabaseAdmin
        .from("competitions")
        .select("tier, gender, name")
        .eq("nff_competition_id", matchRow.nff_competition_id)
        .maybeSingle();
      competition = compRow ?? null;
    }

    const compTier   = competition?.tier   ?? null;
    const compGender = competition?.gender ?? null;

    // Resolve team IDs: DB first, then mapping table, then logo ID
    const resolveId = (logoId: string | null, dbId: string | null) => {
      if (dbId) return dbId;
      if (!logoId) return logoId;
      const mapped = resolveTeamId(logoId, compTier, compGender);
      return mapped?.id ?? logoId;
    };

    const resolvedHomeId = resolveId(homeClubId, matchRow?.home_team_nff_id ? String(matchRow.home_team_nff_id) : null);
    const resolvedAwayId = resolveId(awayClubId, matchRow?.away_team_nff_id ? String(matchRow.away_team_nff_id) : null);

    const teamNameMap = new Map<string, string>();
    if (resolvedHomeId || resolvedAwayId) {
      const ids = [resolvedHomeId, resolvedAwayId].filter(Boolean) as string[];
      const { data: teamRows } = await supabaseAdmin
        .from("computed_league_table")
        .select("nff_team_id, team_name")
        .in("nff_team_id", ids)
        .limit(10);
      for (const r of teamRows ?? []) {
        if (r.nff_team_id && r.team_name) teamNameMap.set(String(r.nff_team_id), r.team_name);
      }
    }

    const teamsFromHtml = extractTeamNamesWithIds(html);

    // Match scraped names to resolved IDs by club logo
    const homeNameFromHtml = teamsFromHtml.find(t => t.clubId === homeClubId)?.name ?? homeName;
    const awayNameFromHtml = teamsFromHtml.find(t => t.clubId === awayClubId)?.name ?? awayName;

    // Use HTML names (correct display names) with DB-resolved IDs (correct home/away)
    const resolvedHomeName = homeNameFromHtml;
    const resolvedAwayName = awayNameFromHtml;

    const home = {
      starters: homePlayers.filter(p => p.role === "starter"),
      bench:    homePlayers.filter(p => p.role === "substitute"),
    };
    const away = {
      starters: awayPlayers.filter(p => p.role === "starter"),
      bench:    awayPlayers.filter(p => p.role === "substitute"),
    };

    return NextResponse.json({
      fiksId,
      inputUrl,
      fetchUrl: matchUrl,
      counts: {
        startersHome: home.starters.length,
        startersAway: away.starters.length,
        benchHome:    home.bench.length,
        benchAway:    away.bench.length,
      },
      teams: {
        home: { nff_team_id: resolvedHomeId, team_name: resolvedHomeName },
        away: { nff_team_id: resolvedAwayId, team_name: resolvedAwayName },
      },
      match: {
        nff_match_id:    fiksId,
        home_score:      score.home ?? matchRow?.home_score ?? null,
        away_score:      score.away ?? matchRow?.away_score ?? null,
        home_halftime:   score.homeHt,
        away_halftime:   score.awayHt,
        kickoff_at:      matchRow?.kickoff_at ?? null,
        season_year:     matchRow?.season_year ?? null,
        competition,
      },
      home,
      away,
    });
  } catch (e: any) {
    console.error("lineups-from-report error:", e);
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}