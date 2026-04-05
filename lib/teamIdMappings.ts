/**
 * team-id-mappings.ts
 *
 * Maps club logo IDs (used in fotball.no match HTML) to their correct team IDs
 * for cases where a club has multiple teams using the same logo.
 *
 * Format:
 *   logoId: {
 *     main: { id, name },           // First/main team
 *     women: { id, name },          // Women's team (optional)
 *     reserve: { id, name },        // Reserve/B team (optional)
 *     youth: { id, name },          // Youth team (optional)
 *   }
 *
 * How to find the correct IDs:
 * - Go to https://www.fotball.no/fotballdata/lag/hjem/?fiksId=<ID>
 * - The ID in the URL is the team-specific fiksId
 *
 * Tiers used to determine which team a match belongs to:
 *   main:    tier 1-4 (men's senior)
 *   women:   gender = Female, tier 1-4
 *   reserve: tier 5+ (men's)
 *   youth:   gender = Youth_Male or Youth_Female
 */

export type TeamSplit = {
  main?:    { id: string; name: string };
  women?:   { id: string; name: string };
  reserve?: { id: string; name: string };
  youth?:   { id: string; name: string };
};

export const TEAM_ID_MAPPINGS: Record<string, TeamSplit> = {
  // Fana: logo 1614 used for both main (T4) and reserve (T5)
  "1614": {
    main:    { id: "415",   name: "Fana" },
    women:   { id: "66615", name: "Fana Kvinner" },
    reserve: { id: "1614",  name: "Fana 2" },
    youth:   { id: "19823", name: "Fana U19" },
  },

  // Tromsø: logo 1509 used for both main (T1) and reserve (T4)
  "1509": {
    main:    { id: "2",      name: "Tromsø" },
    reserve: { id: "155101", name: "Tromsø 2" },
  },

  // Add more as discovered:
  // "LOGO_ID": {
  //   main:    { id: "MAIN_TEAM_ID",    name: "Club Name" },
  //   reserve: { id: "RESERVE_TEAM_ID", name: "Club Name 2" },
  // },
};

/**
 * Given a logo ID and competition tier/gender, returns the correct team ID and name.
 */
export function resolveTeamId(
  logoId: string,
  tier: number | null,
  gender: string | null,
): { id: string; name: string } | null {
  const mapping = TEAM_ID_MAPPINGS[logoId];
  if (!mapping) return null;

  const g = (gender ?? "").toLowerCase();
  const isWomen  = g === "female" || g === "youth_female";
  const isYouth  = g === "youth_male" || g === "youth_female";

  if (isYouth && mapping.youth)  return mapping.youth;
  if (isWomen && mapping.women)  return mapping.women;

  // Men's senior — use tier to distinguish main vs reserve
  if (!isWomen && !isYouth) {
    if (tier && tier <= 4 && mapping.main)    return mapping.main;
    if (tier && tier >= 5 && mapping.reserve) return mapping.reserve;
    if (mapping.main) return mapping.main;
  }

  return null;
}