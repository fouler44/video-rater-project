import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { searchYoutube } from "../services.js";

function getArg(name, fallback = "") {
  const key = `--${name}`;
  const idx = process.argv.indexOf(key);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function toInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function sleep(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  if (!safeMs) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, safeMs));
}

const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!supabaseUrl || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

const totalLimit = Math.max(1, Math.min(2000, toInt(getArg("limit", "1000"), 1000)));
const batchSize = Math.max(25, Math.min(250, toInt(getArg("batch", "200"), 200)));
const delayMs = Math.max(0, toInt(getArg("delay", "180"), 180));
const listId = String(getArg("listId", "")).trim();

let processed = 0;
let updated = 0;
let skipped = 0;
let failed = 0;
let stoppedByQuota = false;
let quotaMessage = "";

while (processed < totalLimit) {
  const pending = totalLimit - processed;
  const currentBatch = Math.min(batchSize, pending);

  let query = supabase
    .from("list_openings")
    .select("id,anime_title,opening_label,youtube_video_id,thumbnail_url")
    .or("youtube_video_id.is.null,youtube_video_id.eq.")
    .order("order_index", { ascending: true })
    .limit(currentBatch);

  if (listId) {
    query = query.eq("list_id", listId);
  }

  const { data: rows, error: selectError } = await query;

  if (selectError) {
    console.error("DB_SELECT_ERROR", selectError.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    break;
  }

  for (const row of rows) {
    processed += 1;

    const queryText = `${row.anime_title} ${row.opening_label} anime opening official crunchyroll tv size 1:30`;

    try {
      const youtube = await searchYoutube(queryText);
      const first = youtube?.items?.[0] || null;
      const videoId = first?.id?.videoId || "";

      if (!videoId) {
        skipped += 1;
      } else {
        const thumbnailUrl = first?.snippet?.thumbnails?.medium?.url || row.thumbnail_url || "";
        const { error: updateError } = await supabase
          .from("list_openings")
          .update({
            youtube_video_id: videoId,
            thumbnail_url: thumbnailUrl,
          })
          .eq("id", row.id);

        if (updateError) {
          failed += 1;
        } else {
          updated += 1;
        }
      }
    } catch (error) {
      const message = String(error?.message || error || "");
      if (message.toLowerCase().includes("quota") || message.includes("403")) {
        stoppedByQuota = true;
        quotaMessage = message;
        break;
      }
      failed += 1;
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }

    if (processed >= totalLimit) {
      break;
    }
  }

  if (stoppedByQuota) {
    break;
  }

  if (rows.length < currentBatch) {
    break;
  }
}

let remainingMissing = null;
{
  let remainingQuery = supabase
    .from("list_openings")
    .select("id", { count: "exact", head: true })
    .or("youtube_video_id.is.null,youtube_video_id.eq.");

  if (listId) {
    remainingQuery = remainingQuery.eq("list_id", listId);
  }

  const { count } = await remainingQuery;
  remainingMissing = count ?? null;
}

console.log(
  JSON.stringify(
    {
      processed,
      updated,
      skipped,
      failed,
      stopped_by_quota: stoppedByQuota,
      quota_message: quotaMessage || null,
      remaining_missing: remainingMissing,
      list_id: listId || null,
      limit: totalLimit,
      batch: batchSize,
      delay_ms: delayMs,
    },
    null,
    2,
  ),
);
