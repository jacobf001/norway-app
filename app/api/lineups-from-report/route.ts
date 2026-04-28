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

function extractCompetitionName(html: string): string | null {
  const m = html.match(/Turnering:\s*<\/span>\s*<a[^>]*>([^<]+)<\/a>/);
  return m ? decodeHtmlEntities(m[1]) : null;
}

function extractClubIdFromWrapper(wrapperHtml: string): string | null {
  const m = wrapperHtml.match(/clublogos\/(\d+)\.png/);
  return m?.[1] ?? null;
}

function extractTeamNameFromWrapper(wrapperHtml: string): string | null {
  const m = wrapperHtml.match(/<h3>\s*([^<]+?)\s*<\/h3>/);
  return m ? decodeHtmlEntities(m[1]) : null;
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
      const idM = item.match(/\/fotballdata\/person\/profil\/\?fiksId=(\d+)/);
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

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const inputUrl = searchParams.get("url");
    if (!inputUrl) {
      return NextResponse.json({ error: "Missing url param" }, { status: 400 });
    }

    const fiksMatch = inputUrl.match(/fiksId=(\d+)/);
    if (!fiksMatch) {
      return NextResponse.json({ error: "Could not find fiksId in URL" }, { status: 400 });
    }
    const fiksId = fiksMatch[1];

    const matchUrl = `https://www.fotball.no/fotballdata/kamp/?fiksId=${fiksId}`;
    const html = await fetchHtml(matchUrl);

    // Extract everything anchored to homeTeamWrapper / awayTeamWrapper
    const homeWrapperIdx = html.indexOf("homeTeamWrapper");
    const awayWrapperIdx = html.indexOf("awayTeamWrapper");
    const homeWrapperHtml = homeWrapperIdx !== -1
      ? html.substring(homeWrapperIdx, awayWrapperIdx !== -1 ? awayWrapperIdx : undefined)
      : "";
    const awayWrapperHtml = awayWrapperIdx !== -1 ? html.substring(awayWrapperIdx) : "";

    console.log("DEBUG wrappers:", {
      homeWrapperIdx,
      awayWrapperIdx,
      homeNameRaw: homeWrapperHtml.substring(0, 200),
    });

    const homeName   = extractTeamNameFromWrapper(homeWrapperHtml);
    const awayName   = extractTeamNameFromWrapper(awayWrapperHtml);
    const homeClubId = extractClubIdFromWrapper(homeWrapperHtml);
    const awayClubId = extractClubIdFromWrapper(awayWrapperHtml);

    const homeSidePlayers = parseSide(homeWrapperHtml);
    const awaySidePlayers = parseSide(awayWrapperHtml);

    const score = extractScore(html);

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
        .select("nff_competition_id, tier, gender, name")
        .eq("nff_competition_id", matchRow.nff_competition_id)
        .maybeSingle();
      competition = compRow ?? null;
    }

    // If no competition from DB, try scraping it from the match page HTML
    if (!competition) {
      const scrapedCompName = extractCompetitionName(html);
      if (scrapedCompName) {
        const { data: compByName } = await supabaseAdmin
          .from("competitions")
          .select("nff_competition_id, tier, gender, name")
          .ilike("name", `%${scrapedCompName}%`)
          .order("season_year", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (compByName) {
          competition = compByName;
        } else {
          const youthMaleMatch = scrapedCompName.match(/G(\d+)/i);
          const youthFemaleMatch = scrapedCompName.match(/J(\d+)/i);
          if (youthMaleMatch || youthFemaleMatch) {
            const age = parseInt((youthMaleMatch ?? youthFemaleMatch)![1]);
            competition = {
              nff_competition_id: null,
              name: scrapedCompName,
              gender: youthMaleMatch ? "Youth_Male" : "Youth_Female",
              tier: age >= 19 ? 5 : age >= 17 ? 6 : 7,
            };
          }
        }
      }
    }

    console.log("DEBUG competition:", competition);

    const compTier   = competition?.tier   ?? null;
    const compGender = competition?.gender ?? (searchParams.get("gender") ?? null);

    // Resolve team IDs: DB first, then mapping table, then logo ID
    const resolveId = (logoId: string | null, dbId: string | null) => {
      // Always try mapping first — it may override the DB ID for youth/women context
      const idToMap = dbId ?? logoId;
      if (idToMap) {
        const mapped = resolveTeamId(idToMap, compTier, compGender);
        if (mapped) return mapped.id;
      }
      if (dbId) return dbId;
      return logoId;
    };

    const resolvedHomeId = resolveId(homeClubId, matchRow?.home_team_nff_id ? String(matchRow.home_team_nff_id) : null);
    const resolvedAwayId = resolveId(awayClubId, matchRow?.away_team_nff_id ? String(matchRow.away_team_nff_id) : null);

    // Name-based fallback if logo ID didn't resolve
    const validateAndResolve = async (logoId: string | null, name: string | null, dbId: string | null): Promise<string | null> => {
      // Check mapping first — may override DB ID for youth/women context
      const idToMap = dbId ?? logoId;
      if (idToMap) {
        const mapped = resolveTeamId(idToMap, compTier, compGender);
        if (mapped) return mapped.id;
      }
      // DB match ID takes priority
      if (dbId) return dbId;

      // If we have a logo ID, validate it matches the expected team name
      if (logoId) {
        const { data } = await supabaseAdmin
          .from("teams")
          .select("nff_team_id, team_name")
          .eq("nff_team_id", logoId)
          .maybeSingle();
        if (data?.nff_team_id && data.team_name && name) {
          const dbName = data.team_name.toLowerCase();
          const expected = name.toLowerCase();
          const firstWord = expected.split(" ")[0];
          if (dbName.includes(firstWord) || expected.includes(dbName.split(" ")[0])) {
            return String(data.nff_team_id);
          }
        }
      }

      if (!name) return null;

      // Exact name match
      const { data: exact } = await supabaseAdmin
        .from("teams").select("nff_team_id").eq("team_name", name).limit(1).maybeSingle();
      if (exact?.nff_team_id) return String(exact.nff_team_id);

      // Partial match — only accept if all words in the search name are in the DB name
      const { data: partial } = await supabaseAdmin
        .from("teams").select("nff_team_id, team_name").ilike("team_name", `%${name}%`).limit(1).maybeSingle();
      if (partial?.nff_team_id) {
        const dbName = (partial.team_name ?? "").toLowerCase();
        const allWordsMatch = name.toLowerCase().split(" ").every(w => dbName.includes(w));
        if (allWordsMatch) return String(partial.nff_team_id);
      }

      // Last resort — strip reserve suffix e.g. "Åsane 2" → "Åsane"
      if (name.endsWith(" 2")) {
        const baseName = name.slice(0, -2).trim();
        const { data: base } = await supabaseAdmin
          .from("teams").select("nff_team_id").eq("team_name", baseName).maybeSingle();
        if (base?.nff_team_id) return String(base.nff_team_id);
      }

      return null;
    };

    const [rawHomeId, rawAwayId] = await Promise.all([
      validateAndResolve(homeClubId, homeName, matchRow?.home_team_nff_id ? String(matchRow.home_team_nff_id) : null),
      validateAndResolve(awayClubId, awayName, matchRow?.away_team_nff_id ? String(matchRow.away_team_nff_id) : null),
    ]);

    // Apply team ID mappings based on competition context
    const finalHomeId = rawHomeId ? (resolveTeamId(rawHomeId, compTier, compGender)?.id ?? rawHomeId) : rawHomeId;
    const finalAwayId = rawAwayId ? (resolveTeamId(rawAwayId, compTier, compGender)?.id ?? rawAwayId) : rawAwayId;

    const teamNameMap = new Map<string, string>();
    if (finalHomeId || finalAwayId) {
      const ids = [finalHomeId, finalAwayId].filter(Boolean) as string[];
      const { data: teamRows } = await supabaseAdmin
        .from("computed_league_table")
        .select("nff_team_id, team_name")
        .in("nff_team_id", ids)
        .limit(10);
      for (const r of teamRows ?? []) {
        if (r.nff_team_id && r.team_name) teamNameMap.set(String(r.nff_team_id), r.team_name);
      }
    }

    const resolvedHomeName = homeName ?? (finalHomeId ? teamNameMap.get(finalHomeId) ?? null : null);
    const resolvedAwayName = awayName ?? (finalAwayId ? teamNameMap.get(finalAwayId) ?? null : null);

    console.log("DEBUG ids:", { homeClubId, awayClubId, finalHomeId, finalAwayId, homeName, awayName });
    console.log("DEBUG finalIds after mapping:", { finalHomeId, finalAwayId, compTier, compGender });
    console.log("DEBUG mapping test:", resolveTeamId('233', compTier, compGender));

    return NextResponse.json({
      fiksId,
      inputUrl,
      fetchUrl: matchUrl,
      counts: {
        startersHome: homeSidePlayers.filter(p => p.role === "starter").length,
        startersAway: awaySidePlayers.filter(p => p.role === "starter").length,
        benchHome:    homeSidePlayers.filter(p => p.role === "substitute").length,
        benchAway:    awaySidePlayers.filter(p => p.role === "substitute").length,
      },
      teams: {
        home: { nff_team_id: finalHomeId, team_name: resolvedHomeName },
        away: { nff_team_id: finalAwayId, team_name: resolvedAwayName },
      },
      match: {
        nff_match_id:  fiksId,
        home_score:    score.home ?? matchRow?.home_score ?? null,
        away_score:    score.away ?? matchRow?.away_score ?? null,
        home_halftime: score.homeHt,
        away_halftime: score.awayHt,
        kickoff_at:    matchRow?.kickoff_at ?? null,
        season_year:   matchRow?.season_year ?? null,
        competition,
      },
      home: {
        starters: homeSidePlayers.filter(p => p.role === "starter"),
        bench:    homeSidePlayers.filter(p => p.role === "substitute"),
      },
      away: {
        starters: awaySidePlayers.filter(p => p.role === "starter"),
        bench:    awaySidePlayers.filter(p => p.role === "substitute"),
      },
    });
  } catch (e: any) {
    console.error("lineups-from-report error:", e);
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}