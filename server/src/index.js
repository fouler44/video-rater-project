import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
const makeSessionToken = () => randomBytes(48).toString("hex");
const BULK_INSERT_CHUNK_SIZE = 500;
const YOUTUBE_ENRICH_DEFAULT_LIMIT = 120;
const SESSION_TTL_DAYS = 30;
const USERNAME_REGEX = /^[a-z0-9_]{3,24}$/;

function sleep(ms = 0) {
  const safeMs = Math.max(0, Number(ms) || 0);
  if (safeMs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, safeMs);
  });
}

function normalizeUsername(value = "") {
  return String(value || "").trim().toLowerCase();
}

function sanitizeDisplayName(value = "") {
  return String(value || "").trim().slice(0, 48);
}

function sanitizeAvatarUrl(value = "") {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed.slice(0, 400) : null;
}

function hashPassword(password = "") {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function safeEqHex(hexA = "", hexB = "") {
  const a = Buffer.from(hexA, "hex");
  const b = Buffer.from(hexB, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function verifyPassword(storedHash = "", rawPassword = "") {
  const value = String(storedHash || "");

  if (value.startsWith("scrypt$")) {
    const [, salt, hashHex] = value.split("$");
    if (!salt || !hashHex) return false;
    const computed = scryptSync(rawPassword, salt, 64).toString("hex");
    return safeEqHex(computed, hashHex);
  }

  if (value.startsWith("sha256$")) {
    const [, salt, hashHex] = value.split("$");
    if (!salt || !hashHex) return false;
    const computed = createHash("sha256").update(`${rawPassword}${salt}`).digest("hex");
    return safeEqHex(computed, hashHex);
  }

  return false;
}

function getBearerToken(req) {
  const raw = String(req.headers.authorization || "");
  if (!raw.toLowerCase().startsWith("bearer ")) return "";
  return raw.slice(7).trim();
}

function mapUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    avatarUrl: user.avatar_url || "",
    role: user.role,
  };
}

async function createSessionForUser(userId) {
  const token = makeSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabaseAdmin.from("app_user_sessions").insert({
    token,
    user_id: userId,
    expires_at: expiresAt,
  });

  if (error) {
    throw new Error(error.message || "Could not create user session");
  }

  return { token, expiresAt };
}

async function getAuthContext(req) {
  const token = getBearerToken(req);
  if (!token) return null;

  const { data: session, error: sessionError } = await supabaseAdmin
    .from("app_user_sessions")
    .select("token,user_id,expires_at")
    .eq("token", token)
    .maybeSingle();

  if (sessionError || !session) return null;

  const expired = new Date(session.expires_at).getTime() <= Date.now();
  if (expired) {
    await supabaseAdmin.from("app_user_sessions").delete().eq("token", token);
    return null;
  }

  const { data: user, error: userError } = await supabaseAdmin
    .from("app_users")
    .select("id,username,display_name,avatar_url,role")
    .eq("id", session.user_id)
    .maybeSingle();

  if (userError || !user) return null;

  // Keep session alive marker for auditability.
  await supabaseAdmin
    .from("app_user_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("token", token);

  return { token, user: mapUser(user), expiresAt: session.expires_at };
}

async function requireAuth(req, res) {
  const auth = await getAuthContext(req);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return auth;
}

function canControlRoom(user, room) {
  return (
    user.role === "admin" ||
    String(room.owner_user_id || "") === String(user.id || "") ||
    String(room.host_uuid || "") === String(user.id || "")
  );
}

async function upsertRoomMembership(roomId, user) {
  const payload = {
    room_id: roomId,
    user_uuid: user.id,
    user_id: user.id,
    display_name: user.displayName,
    avatar_url: user.avatarUrl || null,
  };

  const { error } = await supabaseAdmin.from("room_members").upsert(payload);
  if (!error) return;

  await supabaseAdmin.from("room_participants").upsert({
    room_id: roomId,
    user_uuid: user.id,
    user_name: user.displayName,
    avatar_url: user.avatarUrl || null,
  });
}

app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

app.get("/api/health", (_, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.post("/api/auth/register", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const username = normalizeUsername(req.body?.username);
  const displayName = sanitizeDisplayName(req.body?.displayName);
  const avatarUrl = sanitizeAvatarUrl(req.body?.avatarUrl);
  const password = String(req.body?.password || "");

  if (!USERNAME_REGEX.test(username)) {
    return res.status(400).json({ error: "Username must use a-z, 0-9 or _ (3-24 chars)" });
  }

  if (!displayName) {
    return res.status(400).json({ error: "Display name is required" });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const { data: existing } = await supabaseAdmin
    .from("app_users")
    .select("id")
    .eq("username", username)
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ error: "Username is already taken" });
  }

  const { data: user, error: userError } = await supabaseAdmin
    .from("app_users")
    .insert({
      username,
      display_name: displayName,
      avatar_url: avatarUrl,
      role: "user",
    })
    .select("id,username,display_name,avatar_url,role")
    .single();

  if (userError) {
    return res.status(500).json({ error: userError.message });
  }

  await supabaseAdmin
    .from("app_users")
    .update({ legacy_uuid: user.id })
    .eq("id", user.id);

  const { error: credentialError } = await supabaseAdmin.from("app_user_credentials").insert({
    user_id: user.id,
    password_hash: hashPassword(password),
  });

  if (credentialError) {
    return res.status(500).json({ error: credentialError.message });
  }

  const session = await createSessionForUser(user.id);

  res.status(201).json({
    token: session.token,
    expiresAt: session.expiresAt,
    user: mapUser(user),
  });
});

app.post("/api/auth/login", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || "");

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  const { data: user, error: userError } = await supabaseAdmin
    .from("app_users")
    .select("id,username,display_name,avatar_url,role")
    .eq("username", username)
    .maybeSingle();

  if (userError) return res.status(500).json({ error: userError.message });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const { data: credential, error: credentialError } = await supabaseAdmin
    .from("app_user_credentials")
    .select("password_hash")
    .eq("user_id", user.id)
    .maybeSingle();

  if (credentialError) return res.status(500).json({ error: credentialError.message });
  if (!credential || !verifyPassword(credential.password_hash, password)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const session = await createSessionForUser(user.id);

  res.json({
    token: session.token,
    expiresAt: session.expiresAt,
    user: mapUser(user),
  });
});

app.get("/api/auth/me", async (req, res) => {
  if (!ensureSupabase(res)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;
  res.json({ user: auth.user, expiresAt: auth.expiresAt });
});

app.post("/api/auth/profile", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const nextDisplayName = sanitizeDisplayName(req.body?.displayName || auth.user.displayName);
  const nextAvatarUrl = sanitizeAvatarUrl(req.body?.avatarUrl);

  if (!nextDisplayName) {
    return res.status(400).json({ error: "Display name is required" });
  }

  const { data, error } = await supabaseAdmin
    .from("app_users")
    .update({
      display_name: nextDisplayName,
      avatar_url: nextAvatarUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", auth.user.id)
    .select("id,username,display_name,avatar_url,role")
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({ user: mapUser(data) });
});

app.post("/api/auth/logout", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const token = getBearerToken(req);
  if (!token) return res.status(204).send();

  await supabaseAdmin.from("app_user_sessions").delete().eq("token", token);
  res.status(204).send();
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
    .select("id,name,is_public,invite_code,current_opening_index,status,created_at,owner_user_id,lists(name)")
    .eq("is_public", true)
    .in("status", ["active", "waiting", "playing"])
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

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const name = String(req.body?.name || "").trim();
  const listId = String(req.body?.listId || "").trim();
  const isPublic = Boolean(req.body?.isPublic);

  if (!name || !listId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const inviteCode = makeInviteCode();
  const { data: room, error: roomError } = await supabaseAdmin
    .from("rooms")
    .insert({
      name,
      list_id: listId,
      host_uuid: auth.user.id,
      owner_user_id: auth.user.id,
      is_public: isPublic,
      invite_code: inviteCode,
      current_opening_index: 0,
      status: "waiting",
    })
    .select("id,name,invite_code,owner_user_id")
    .single();

  if (roomError) return res.status(500).json({ error: roomError.message });

  await upsertRoomMembership(room.id, auth.user);

  res.status(201).json({ room });
});

app.post("/api/rooms/status", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const roomId = String(req.body?.roomId || "").trim();
  const status = String(req.body?.status || "").trim();
  const allowedStatus = ["waiting", "playing", "finished", "active"];

  if (!roomId || !allowedStatus.includes(status)) {
    return res.status(400).json({ error: "Invalid roomId or status" });
  }

  const { data: room, error: roomError } = await supabaseAdmin
    .from("rooms")
    .select("id,owner_user_id,host_uuid")
    .eq("id", roomId)
    .single();

  if (roomError) return res.status(500).json({ error: roomError.message });
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (!canControlRoom(auth.user, room)) {
    return res.status(403).json({ error: "Only the host/owner or admin can change status" });
  }

  const { data, error } = await supabaseAdmin
    .from("rooms")
    .update({ status })
    .eq("id", roomId)
    .select("id,status")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ room: data });
});

app.post("/api/rooms/rate", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const roomId = String(req.body?.roomId || "").trim();
  const openingId = String(req.body?.openingId || "").trim();
  const score = Number(req.body?.score);

  if (!roomId || !openingId || !Number.isInteger(score) || score < 1 || score > 10) {
    return res.status(400).json({ error: "Invalid rating payload" });
  }

  const { data: room, error: roomError } = await supabaseAdmin
    .from("rooms")
    .select("id")
    .eq("id", roomId)
    .maybeSingle();

  if (roomError) return res.status(500).json({ error: roomError.message });
  if (!room) return res.status(404).json({ error: "Room not found" });

  await upsertRoomMembership(roomId, auth.user);

  const { data, error } = await supabaseAdmin
    .from("ratings")
    .upsert({
      room_id: roomId,
      list_opening_id: openingId,
      user_uuid: auth.user.id,
      user_id: auth.user.id,
      score,
    }, { onConflict: "room_id,list_opening_id,user_uuid" })
    .select("id,room_id,list_opening_id,user_uuid,user_id,score")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ rating: data });
});

app.post("/api/rooms/:roomId/advance", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const roomId = req.params.roomId;
  const parsedIndex = Number(req.body?.nextIndex);

  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    return res.status(400).json({ error: "Invalid nextIndex" });
  }

  const { data: room, error: roomError } = await supabaseAdmin
    .from("rooms")
    .select("id,owner_user_id,host_uuid,status")
    .eq("id", roomId)
    .single();

  if (roomError) return res.status(500).json({ error: roomError.message });
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (!canControlRoom(auth.user, room)) {
    return res.status(403).json({ error: "Only the host/owner or admin can change the opening" });
  }

  const { data, error } = await supabaseAdmin
    .from("rooms")
    .update({ current_opening_index: parsedIndex })
    .eq("id", roomId)
    .select("id,current_opening_index,status")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ room: data });
});

app.post("/api/rooms/:roomId/opening", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const roomId = req.params.roomId;
  const parsedIndex = Number(req.body?.openingIndex);

  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    return res.status(400).json({ error: "Invalid openingIndex" });
  }

  const { data: room, error: roomError } = await supabaseAdmin
    .from("rooms")
    .select("id,owner_user_id,host_uuid")
    .eq("id", roomId)
    .single();

  if (roomError) return res.status(500).json({ error: roomError.message });
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (!canControlRoom(auth.user, room)) {
    return res.status(403).json({ error: "Only the host/owner or admin can change the opening" });
  }

  const { data, error } = await supabaseAdmin
    .from("rooms")
    .update({ current_opening_index: parsedIndex })
    .eq("id", roomId)
    .select("id,current_opening_index,status")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ room: data });
});

app.post("/api/rooms/:roomId/end", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const roomId = req.params.roomId;

  const { data: roomData, error: roomError } = await supabaseAdmin
    .from("rooms")
    .select("id,list_id,owner_user_id,host_uuid")
    .eq("id", roomId)
    .single();

  if (roomError) return res.status(500).json({ error: roomError.message });
  if (!roomData) return res.status(404).json({ error: "Room not found" });
  if (!canControlRoom(auth.user, roomData)) {
    return res.status(403).json({ error: "Only the host/owner or admin can end the room" });
  }

  const { data: openings, error: openingsError } = await supabaseAdmin
    .from("list_openings")
    .select("id")
    .eq("list_id", roomData.list_id);

  if (openingsError) return res.status(500).json({ error: openingsError.message });

  const { data: ratings, error: ratingsError } = await supabaseAdmin
    .from("ratings")
    .select("list_opening_id,user_uuid,user_id,score")
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
        user_id: null,
        score: Number(avg.toFixed(2)),
      });
    }

    for (const rating of scoped) {
      rankingRows.push({
        room_id: roomId,
        list_opening_id: openingId,
        ranking_type: "personal",
        user_uuid: rating.user_uuid,
        user_id: rating.user_id || null,
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

app.delete("/api/rooms/:roomId", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const roomId = req.params.roomId;

  const { data: room, error: roomError } = await supabaseAdmin
    .from("rooms")
    .select("id,owner_user_id,host_uuid")
    .eq("id", roomId)
    .maybeSingle();

  if (roomError) return res.status(500).json({ error: roomError.message });
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (!canControlRoom(auth.user, room)) {
    return res.status(403).json({ error: "Only the room owner/host or admin can delete this room" });
  }

  const { error: deleteError } = await supabaseAdmin
    .from("rooms")
    .delete()
    .eq("id", roomId);

  if (deleteError) return res.status(500).json({ error: deleteError.message });

  res.status(204).send();
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
