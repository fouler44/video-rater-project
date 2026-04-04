import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { customAlphabet } from "nanoid";
import {
  buildMalTopOpeningsDataset,
  buildPresetTopOpenings,
  getAnimeThemes,
  getTopAnime,
  searchAnime,
  searchYoutube,
} from "./services.js";
import { hasSupabaseConfig, supabaseAdmin } from "./supabase.js";

const app = express();
const port = Number(process.env.PORT || 4000);
const clientOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const makeInviteCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
const BULK_INSERT_CHUNK_SIZE = 500;
const YOUTUBE_ENRICH_DEFAULT_LIMIT = 120;

function sleep(ms = 0) {
  const safeMs = Math.max(0, Number(ms) || 0);
  if (safeMs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, safeMs);
  });
}

app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

app.get("/api/health", (_, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get("/api/jikan/top-anime", async (req, res) => {
  try {
    const data = await getTopAnime(req.query.limit);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/jikan/search-anime", async (req, res) => {
  try {
    const data = await searchAnime(String(req.query.q || ""));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/jikan/anime/:animeId/themes", async (req, res) => {
  try {
    const data = await getAnimeThemes(req.params.animeId);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/youtube/search", async (req, res) => {
  try {
    const data = await searchYoutube(String(req.query.q || ""));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/lists/preset/top-mal-openings", async (req, res) => {
  try {
    const source = req.query.source === "popular" ? "popular" : "score";
    const openings = await buildPresetTopOpenings(req.query.limit || 20, source);
    res.json({ openings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/import/top-mal-openings", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const importSecret = process.env.IMPORT_PRESET_SECRET;
  if (importSecret) {
    const providedSecret = String(req.headers["x-import-secret"] || "");
    if (providedSecret !== importSecret) {
      return res.status(403).json({ error: "Invalid import secret" });
    }
  }

  const {
    topLimit = 300,
    source = "popular",
    includeYoutube = false,
    listName,
    createdBy,
    maxOpeningsPerAnime = 6,
    themeDelayMs = 350,
    youtubeDelayMs = 175,
  } = req.body || {};

  try {
    const openings = await buildMalTopOpeningsDataset({
      topLimit,
      source,
      includeYoutube,
      maxOpeningsPerAnime,
      themeDelayMs,
      youtubeDelayMs,
    });

    if (openings.length === 0) {
      return res.status(400).json({ error: "No openings found for import" });
    }

    const safeSource = source === "score" ? "score" : "popular";
    const finalListName =
      String(listName || "").trim() ||
      `MAL Top ${Math.max(1, Math.min(300, Number(topLimit) || 300))} (${safeSource})`; 
    const finalCreatedBy = String(createdBy || "").trim() || "system:mal-import";

    const { data: list, error: listError } = await supabaseAdmin
      .from("lists")
      .insert({
        name: finalListName,
        created_by: finalCreatedBy,
        is_preset: true,
      })
      .select("id,name,created_by,is_preset,created_at")
      .single();

    if (listError) {
      return res.status(500).json({ error: listError.message });
    }

    const openingRows = openings.map((opening, index) => ({
      ...opening,
      list_id: list.id,
      order_index: index,
    }));

    for (let start = 0; start < openingRows.length; start += BULK_INSERT_CHUNK_SIZE) {
      const chunk = openingRows.slice(start, start + BULK_INSERT_CHUNK_SIZE);
      const { error: chunkError } = await supabaseAdmin.from("list_openings").insert(chunk);
      if (chunkError) {
        return res.status(500).json({ error: chunkError.message, listId: list.id });
      }
    }

    res.status(201).json({
      list,
      imported_openings: openingRows.length,
      include_youtube: Boolean(includeYoutube),
      top_limit: Math.max(1, Math.min(300, Number(topLimit) || 300)),
      source: safeSource,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/enrich-youtube", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const importSecret = process.env.IMPORT_PRESET_SECRET;
  if (importSecret) {
    const providedSecret = String(req.headers["x-import-secret"] || "");
    if (providedSecret !== importSecret) {
      return res.status(403).json({ error: "Invalid import secret" });
    }
  }

  const {
    listId,
    limit = YOUTUBE_ENRICH_DEFAULT_LIMIT,
    delayMs = 200,
    onlyMissing = true,
  } = req.body || {};

  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || YOUTUBE_ENRICH_DEFAULT_LIMIT));
  const safeDelay = Math.max(0, Number(delayMs) || 0);

  try {
    let query = supabaseAdmin
      .from("list_openings")
      .select("id,list_id,anime_title,opening_label,youtube_video_id,thumbnail_url")
      .order("order_index", { ascending: true })
      .limit(safeLimit);

    if (listId) {
      query = query.eq("list_id", String(listId));
    }

    if (onlyMissing) {
      query = query.or("youtube_video_id.is.null,youtube_video_id.eq.");
    }

    const { data: targets, error: targetsError } = await query;
    if (targetsError) return res.status(500).json({ error: targetsError.message });

    const rows = targets || [];
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    let stoppedByQuota = false;
    let quotaMessage = "";

    for (const row of rows) {
      const hasVideoId = Boolean(String(row.youtube_video_id || "").trim());
      if (onlyMissing && hasVideoId) {
        skipped += 1;
        continue;
      }

      const queryText = `${row.anime_title} ${row.opening_label} anime opening official crunchyroll tv size 1:30`;

      try {
        const youtube = await searchYoutube(queryText);
        const first = youtube.items?.[0] || null;
        const videoId = first?.id?.videoId || "";

        if (!videoId) {
          skipped += 1;
        } else {
          const thumbnailUrl = first?.snippet?.thumbnails?.medium?.url || row.thumbnail_url || "";

          const { error: updateError } = await supabaseAdmin
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
        const message = String(error?.message || "");
        if (message.toLowerCase().includes("quota") || message.includes("403")) {
          stoppedByQuota = true;
          quotaMessage = message;
          break;
        }
        failed += 1;
      }

      if (safeDelay > 0) {
        await sleep(safeDelay);
      }
    }

    res.json({
      processed: rows.length,
      updated,
      skipped,
      failed,
      stopped_by_quota: stoppedByQuota,
      quota_message: quotaMessage || null,
      list_id: listId || null,
      only_missing: Boolean(onlyMissing),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function ensureSupabase(res) {
  if (!hasSupabaseConfig || !supabaseAdmin) {
    res.status(500).json({ error: "Supabase config missing in backend environment" });
    return false;
  }
  return true;
}

app.get("/api/rooms/public", async (_, res) => {
  if (!ensureSupabase(res)) return;

  const { data, error } = await supabaseAdmin
    .from("rooms")
    .select("id,name,is_public,invite_code,current_opening_index,status,created_at,lists(name)")
    .eq("is_public", true)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ rooms: data || [] });
});

app.get("/api/rooms/by-code/:code", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const { data, error } = await supabaseAdmin
    .from("rooms")
    .select("id,name,invite_code,is_public,status")
    .ilike("invite_code", req.params.code)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Room not found" });
  res.json({ room: data });
});

app.post("/api/rooms", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const { name, listId, userUuid, displayName, isPublic } = req.body;
  if (!name || !listId || !userUuid || !displayName) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const inviteCode = makeInviteCode();
  const { data: room, error: roomError } = await supabaseAdmin
    .from("rooms")
    .insert({
      name,
      list_id: listId,
      host_uuid: userUuid,
      is_public: Boolean(isPublic),
      invite_code: inviteCode,
      current_opening_index: 0,
      status: "active",
    })
    .select("id,name,invite_code")
    .single();

  if (roomError) return res.status(500).json({ error: roomError.message });

  await supabaseAdmin.from("room_members").upsert({
    room_id: room.id,
    user_uuid: userUuid,
    display_name: displayName,
  });

  res.status(201).json({ room });
});

app.post("/api/rooms/:roomId/advance", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const { nextIndex } = req.body;
  const { data, error } = await supabaseAdmin
    .from("rooms")
    .update({ current_opening_index: nextIndex })
    .eq("id", req.params.roomId)
    .select("id,current_opening_index,status")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ room: data });
});

app.post("/api/rooms/:roomId/end", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const roomId = req.params.roomId;

  const { data: roomData, error: roomError } = await supabaseAdmin
    .from("rooms")
    .select("id,list_id")
    .eq("id", roomId)
    .single();

  if (roomError) return res.status(500).json({ error: roomError.message });

  const { data: openings, error: openingsError } = await supabaseAdmin
    .from("list_openings")
    .select("id")
    .eq("list_id", roomData.list_id);

  if (openingsError) return res.status(500).json({ error: openingsError.message });

  const { data: ratings, error: ratingsError } = await supabaseAdmin
    .from("ratings")
    .select("list_opening_id,user_uuid,score")
    .eq("room_id", roomId);

  if (ratingsError) return res.status(500).json({ error: ratingsError.message });

  const rankingRows = [];
  const openingIds = (openings || []).map((item) => item.id);

  for (const openingId of openingIds) {
    const scoped = (ratings || []).filter((r) => r.list_opening_id === openingId);
    if (scoped.length > 0) {
      const avg = scoped.reduce((sum, r) => sum + r.score, 0) / scoped.length;
      rankingRows.push({
        room_id: roomId,
        list_opening_id: openingId,
        ranking_type: "group",
        user_uuid: null,
        score: Number(avg.toFixed(2)),
      });
    }

    for (const rating of scoped) {
      rankingRows.push({
        room_id: roomId,
        list_opening_id: openingId,
        ranking_type: "personal",
        user_uuid: rating.user_uuid,
        score: rating.score,
      });
    }
  }

  await supabaseAdmin.from("room_rankings").delete().eq("room_id", roomId);
  if (rankingRows.length > 0) {
    const { error: rankingsError } = await supabaseAdmin.from("room_rankings").insert(rankingRows);
    if (rankingsError) return res.status(500).json({ error: rankingsError.message });
  }

  const { data, error } = await supabaseAdmin
    .from("rooms")
    .update({ status: "finished" })
    .eq("id", roomId)
    .select("id,status")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ room: data, rankingsStored: rankingRows.length });
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, "../../client/dist");

if (process.env.NODE_ENV === "production") {
  app.use(express.static(clientDist));
  app.get("*", (_, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API running on http://localhost:${port}`);
});
