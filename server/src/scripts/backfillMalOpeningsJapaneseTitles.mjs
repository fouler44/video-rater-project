import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const LIST_ID = String(process.env.LIST_ID || "").trim();
const LIST_NAME = String(process.env.LIST_NAME || "").trim();
const DELAY_MS = Math.max(0, Number(process.env.DELAY_MS || 250));

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

if (!LIST_ID && !LIST_NAME) {
  throw new Error("Set LIST_ID or LIST_NAME");
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
    const retryMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(10000, 1200 * (attempt + 1));
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
    String(anime?.title_english || "").trim()
  );
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let listQuery = supabase.from("lists").select("id,name,list_source,is_preset");
  if (LIST_ID) {
    listQuery = listQuery.eq("id", LIST_ID);
  } else {
    listQuery = listQuery.eq("name", LIST_NAME);
  }

  const { data: lists, error: listError } = await listQuery.eq("list_source", "mal").order("created_at", { ascending: false });
  if (listError) throw listError;
  if (!lists?.length) {
    throw new Error("List not found");
  }

  for (const list of lists) {
    const { data: openings, error: openingsError } = await supabase
      .from("list_openings")
      .select("id,anime_id,anime_title,order_index")
      .eq("list_id", list.id)
      .order("order_index", { ascending: true });

    if (openingsError) throw openingsError;

    const uniqueAnimeIds = [...new Set((openings || []).map((row) => Number(row.anime_id)).filter((id) => Number.isFinite(id) && id > 0))];
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    console.log(`Backfilling list ${list.name} (${list.id}) with ${uniqueAnimeIds.length} anime ids`);

    for (const animeId of uniqueAnimeIds) {
      const affectedCount = (openings || []).filter((row) => Number(row.anime_id) === animeId).length;

      try {
        const json = await fetchJson(`https://api.jikan.moe/v4/anime/${animeId}`);
        const anime = json?.data || {};
        const romajiTitle = resolveRomajiTitle(anime);

        if (!romajiTitle) {
          skipped += affectedCount;
          continue;
        }

        const { error: updateError } = await supabase
          .from("list_openings")
          .update({ anime_title: romajiTitle })
          .eq("list_id", list.id)
          .eq("anime_id", animeId);

        if (updateError) throw updateError;

        updated += affectedCount;
        console.log(`${animeId} -> ${romajiTitle}`);
      } catch (error) {
        failed += affectedCount;
        console.error(`failed ${animeId}:`, error.message || error);
      }

      if (DELAY_MS > 0) {
        await delay(DELAY_MS);
      }
    }

    console.log(JSON.stringify({ listId: list.id, name: list.name, updated, skipped, failed }, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
