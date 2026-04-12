import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const START_ORDER_INDEX = Math.max(0, Number(process.env.START_ORDER_INDEX || 369));
const BATCH_SIZE = Math.max(1, Math.min(1000, Number(process.env.BATCH_SIZE || 500)));
const DELAY_MS = Math.max(0, Number(process.env.DELAY_MS || 250));

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

function delay(ms = 0) {
  const safeMs = Math.max(0, Number(ms) || 0);
  if (safeMs === 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, safeMs));
}

async function fetchJson(url, attempt = 0) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (response.ok) {
    return response.json();
  }

  const body = await response.text();
  if (response.status === 429 && attempt < 5) {
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    const retryMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(12000, 1500 * (attempt + 1));
    await delay(retryMs);
    return fetchJson(url, attempt + 1);
  }

  throw new Error(`${response.status} ${response.statusText} - ${body}`);
}

function resolveRomajiTitle(anime = {}) {
  return (
    String(anime?.title || "").trim() ||
    String(anime?.titles?.find((entry) => String(entry?.type || "").toLowerCase() === "default")?.title || "").trim() ||
    String(anime?.title_romanized || "").trim() ||
    String(anime?.title_english || "").trim() ||
    String(anime?.title_japanese || "").trim()
  );
}

async function loadRowsChunk(supabase, from, to) {
  const { data, error } = await supabase
    .from("list_openings")
    .select("id,list_id,anime_id,anime_title,order_index")
    .gte("order_index", START_ORDER_INDEX)
    .order("order_index", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to);

  if (error) throw error;
  return data || [];
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const allRows = [];
  let offset = 0;

  while (true) {
    const chunk = await loadRowsChunk(supabase, offset, offset + BATCH_SIZE - 1);
    if (chunk.length === 0) break;
    allRows.push(...chunk);
    offset += chunk.length;
    if (chunk.length < BATCH_SIZE) break;
  }

  if (allRows.length === 0) {
    console.log(`No rows found with order_index >= ${START_ORDER_INDEX}`);
    return;
  }

  const animeIds = [...new Set(
    allRows
      .map((row) => Number(row.anime_id))
      .filter((animeId) => Number.isFinite(animeId) && animeId > 0),
  )];

  console.log(
    `Rows to evaluate: ${allRows.length}. Unique anime IDs: ${animeIds.length}. Start order index: ${START_ORDER_INDEX}`,
  );

  const titleByAnimeId = new Map();
  let apiFailed = 0;
  let skippedMissingInJikan = 0;

  for (const animeId of animeIds) {
    try {
      const json = await fetchJson(`https://api.jikan.moe/v4/anime/${animeId}`);
      const romaji = resolveRomajiTitle(json?.data || {});
      if (romaji) {
        titleByAnimeId.set(animeId, romaji);
      }
    } catch (error) {
      const message = String(error?.message || error || "");
      if (message.includes("404")) {
        skippedMissingInJikan += 1;
      } else {
        apiFailed += 1;
        console.error(`Jikan failed for anime_id ${animeId}: ${message}`);
      }
    }

    if (DELAY_MS > 0) {
      await delay(DELAY_MS);
    }
  }

  let updated = 0;
  let skippedNoRomaji = 0;
  let updateFailed = 0;

  for (const row of allRows) {
    const animeId = Number(row.anime_id);
    const romaji = titleByAnimeId.get(animeId);

    if (!romaji) {
      skippedNoRomaji += 1;
      continue;
    }

    if (String(row.anime_title || "").trim() === romaji) {
      continue;
    }

    const { error } = await supabase
      .from("list_openings")
      .update({ anime_title: romaji })
      .eq("id", row.id);

    if (error) {
      updateFailed += 1;
      console.error(`Update failed for row ${row.id}: ${error.message || error}`);
      continue;
    }

    updated += 1;
    console.log(`Updated row ${row.id}: ${row.anime_title} -> ${romaji}`);
  }

  console.log(JSON.stringify({
    startOrderIndex: START_ORDER_INDEX,
    rowsEvaluated: allRows.length,
    uniqueAnimeIds: animeIds.length,
    updated,
    skippedNoRomaji,
    skippedMissingInJikan,
    apiFailed,
    updateFailed,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
