import "dotenv/config";
import { supabaseAdmin } from "../supabase.js";

const JIKAN_BASE = "https://api.jikan.moe/v4";

async function fetchJson(url) {
  const maxRetries = 4;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) {
      return await response.json();
    }

    if (response.status === 429 && attempt < maxRetries) {
      const retryAfterHeader = Number(response.headers.get("retry-after") || 0);
      const retryMs = retryAfterHeader > 0 ? retryAfterHeader * 1000 : Math.random() * 5000;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      continue;
    }

    throw new Error(`HTTP ${response.status}`);
  }
}

function extractThemeLabel(themeString) {
  if (!themeString) return "";
  // Remove numbering like "1. " or "OP 1: " from the start
  return themeString.replace(/^[\d.]+\s*[:\-]?\s*(OP|ED)?\s*\d*\s*[:\-]?\s*/i, "").trim();
}

async function getAnimeThemesFromJikan(animeId) {
  try {
    const url = `${JIKAN_BASE}/anime/${animeId}/themes`;
    const result = await fetchJson(url);
    return result?.data || { openings: [], endings: [] };
  } catch (err) {
    console.error(`Failed to fetch themes for anime ${animeId}:`, err.message);
    return { openings: [], endings: [] };
  }
}

async function main() {
  console.log("Starting backfill of theme_kind from Jikan API...");

  try {
    // Get all rows and deduplicate client-side
    const { data: allRows, error: fetchError } = await supabaseAdmin
      .from("list_openings")
      .select("anime_id, anime_title");

    if (fetchError) {
      throw new Error(`Fetch error: ${fetchError.message}`);
    }

    // Deduplicate by anime_id
    const animesMap = new Map();
    for (const row of allRows) {
      if (!animesMap.has(row.anime_id)) {
        animesMap.set(row.anime_id, row.anime_title);
      }
    }

    const animes = Array.from(animesMap).map(([anime_id, anime_title]) => ({ anime_id, anime_title }));

    console.log(`Found ${animes.length} distinct animes`);

    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const { anime_id, anime_title } of animes) {
      console.log(`\nProcessing anime_id=${anime_id} (${anime_title})`);

      try {
        // Get themes from Jikan
        const jikanThemes = await getAnimeThemesFromJikan(anime_id);
        const openingLabels = (jikanThemes.openings || []).map(extractThemeLabel).filter(Boolean);
        const endingLabels = (jikanThemes.endings || []).map(extractThemeLabel).filter(Boolean);

        console.log(`  - Jikan openings: ${openingLabels.length}`);
        console.log(`  - Jikan endings: ${endingLabels.length}`);

        // Create a map of sanitized labels to theme_kind
        const themeMap = {};

        openingLabels.forEach((label, idx) => {
          const count = openingLabels.length;
          const key = label.toLowerCase().trim();
          themeMap[key] = count === 1 ? "OP" : `OP ${idx + 1}`;
        });

        endingLabels.forEach((label, idx) => {
          const count = endingLabels.length;
          const key = label.toLowerCase().trim();
          themeMap[key] = count === 1 ? "ED" : `ED ${idx + 1}`;
        });

        // Get all openings for this anime from DB
        const { data: dbOpenings, error: dbError } = await supabaseAdmin
          .from("list_openings")
          .select("id, opening_label, theme_kind")
          .eq("anime_id", anime_id);

        if (dbError) {
          console.error(`  Error fetching DB openings: ${dbError.message}`);
          errorCount++;
          continue;
        }

        console.log(`  - Found ${dbOpenings.length} rows in DB`);

        // Update each row
        let updatedCount = 0;
        for (const row of dbOpenings) {
          const sanitized = row.opening_label
            .replace(/^(OP|ED)\s*-?\s*/i, "") // Remove OP- or ED- prefix
            .toLowerCase()
            .trim();

          const matchedThemeKind = Object.entries(themeMap).find(([key]) =>
            sanitized.includes(key) || key.includes(sanitized),
          )?.[1];

          if (matchedThemeKind && matchedThemeKind !== row.theme_kind) {
            console.log(`    - Updating row ${row.id}: "${row.opening_label}" → ${matchedThemeKind}`);

            const { error: updateError } = await supabaseAdmin
              .from("list_openings")
              .update({ theme_kind: matchedThemeKind })
              .eq("id", row.id);

            if (updateError) {
              console.error(`      Error updating: ${updateError.message}`);
            } else {
              updatedCount++;
            }
          }
        }

        if (updatedCount > 0) {
          console.log(`  ✓ Updated ${updatedCount} rows`);
          successCount++;
        } else {
          console.log(`  - No changes needed`);
          skipCount++;
        }
      } catch (err) {
        console.error(`  ✗ Error: ${err.message}`);
        errorCount++;
      }

      // Rate limiting: wait between requests
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log("\n=== Backfill Summary ===");
    console.log(`Success: ${successCount}`);
    console.log(`Skipped: ${skipCount}`);
    console.log(`Errors: ${errorCount}`);
  } catch (err) {
    console.error("Fatal error:", err.message);
    process.exit(1);
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
