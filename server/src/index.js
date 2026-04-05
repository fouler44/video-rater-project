import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { customAlphabet } from "nanoid";
import {
  buildMalTopOpeningsDataset,
  buildPresetTopOpenings,
  getAnimeThemes,
  importYoutubePlaylist,
  getTopAnime,
  searchAnime,
  searchYoutube,
} from "./services.js";
import { hasSupabaseConfig, supabaseAdmin } from "./supabase.js";

const app = express();
const REQUIRED_ENV_VARS = [
  "CLIENT_ORIGIN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PARTYKIT_INTERNAL_SECRET",
  "PARTYKIT_API_SIGNING_SECRET",
];

for (const name of REQUIRED_ENV_VARS) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const port = Number(process.env.PORT || 4000);
const clientOrigin = String(process.env.CLIENT_ORIGIN || "").trim();
const makeInviteCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
const makeSessionToken = () => randomBytes(48).toString("hex");
const BULK_INSERT_CHUNK_SIZE = 500;
const YOUTUBE_ENRICH_DEFAULT_LIMIT = 120;
const SESSION_TTL_DAYS = 30;
const USERNAME_REGEX = /^[a-z0-9_]{3,24}$/;
const PARTYKIT_INTERNAL_SECRET = String(process.env.PARTYKIT_INTERNAL_SECRET || "").trim();
const PARTYKIT_API_SIGNING_SECRET = String(process.env.PARTYKIT_API_SIGNING_SECRET || "").trim();
const INTERNAL_MAX_SKEW_MS = 30_000;
const usedInternalNonces = new Map();

const RoomIdSchema = z.string().uuid();
const ListIdSchema = z.string().uuid();
const ScoreSchema = z.number().int().min(1).max(10);
const RoomStatusSchema = z.enum(["waiting", "playing", "finished"]);

const SaveListSchema = z.object({
  listId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  isPreset: z.boolean().optional().default(false),
  source: z.enum(["mal", "youtube"]).optional().default("mal"),
  openings: z.array(
    z.object({
      anime_id: z.number().int().positive(),
      anime_title: z.string().trim().min(1).max(240),
      opening_label: z.string().trim().min(1).max(120),
      youtube_video_id: z.string().trim().max(30).nullable().optional(),
      thumbnail_url: z.string().trim().max(600).nullable().optional(),
    }),
  ).min(1),
});

const ImportYoutubePlaylistSchema = z.object({
  playlistUrl: z.string().trim().min(1).max(800),
  listName: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(300).optional(),
});

function logEvent(level, event, details = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...details,
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

function cleanupInternalNonces() {
  const now = Date.now();
  for (const [nonce, expiresAt] of usedInternalNonces.entries()) {
    if (expiresAt <= now) {
      usedInternalNonces.delete(nonce);
    }
  }
}

function hashRawBody(rawBody = "") {
  return createHash("sha256").update(String(rawBody || "")).digest("hex");
}

function buildInternalSignature({ timestamp, nonce, method, path, bodyHash }) {
  const canonical = `${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${bodyHash}`;
  return createHmac("sha256", PARTYKIT_API_SIGNING_SECRET).update(canonical).digest("hex");
}

function parseSchema(schema, payload, res, message = "Invalid request payload") {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    res.status(400).json({ error: message });
    return null;
  }
  return parsed.data;
}

function internalError(req, res, error, event = "internal_error") {
  logEvent("error", event, {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    error: String(error?.stack || error?.message || error || "unknown"),
  });
  return res.status(500).json({ error: "Internal server error" });
}

function sleep(ms = 0) {
  const safeMs = Math.max(0, Number(ms) || 0);
  if (safeMs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, safeMs);
  });
}

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts. Please try again later." },
});

const joinByCodeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many room code attempts. Please try again later." },
});

const adminLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests. Please try again later." },
});

const externalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit reached. Please try again shortly." },
});

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
  req.auth = auth;
  return auth;
}

async function requireAdmin(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (auth.user.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
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

function ensureInternalPartykit(req, res) {
  const providedSecret = String(req.headers["x-partykit-secret"] || "").trim();
  if (providedSecret !== PARTYKIT_INTERNAL_SECRET) {
    res.status(401).json({ error: "Unauthorized PartyKit request" });
    return false;
  }

  const timestampRaw = String(req.headers["x-partykit-timestamp"] || "").trim();
  const nonce = String(req.headers["x-partykit-nonce"] || "").trim();
  const signature = String(req.headers["x-partykit-signature"] || "").trim();

  if (!timestampRaw || !nonce || !signature) {
    res.status(401).json({ error: "Missing PartyKit signature headers" });
    return false;
  }

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) {
    res.status(401).json({ error: "Invalid PartyKit timestamp" });
    return false;
  }

  const ageMs = Math.abs(Date.now() - timestamp);
  if (ageMs > INTERNAL_MAX_SKEW_MS) {
    res.status(401).json({ error: "Expired PartyKit request" });
    return false;
  }

  cleanupInternalNonces();
  if (usedInternalNonces.has(nonce)) {
    res.status(401).json({ error: "Replay detected" });
    return false;
  }

  const bodyHash = hashRawBody(req.rawBody || "");
  const expected = buildInternalSignature({
    timestamp: String(timestamp),
    nonce,
    method: req.method,
    path: req.originalUrl,
    bodyHash,
  });

  if (!safeEqHex(expected, signature)) {
    res.status(401).json({ error: "Invalid PartyKit signature" });
    return false;
  }

  usedInternalNonces.set(nonce, Date.now() + INTERNAL_MAX_SKEW_MS);

  return true;
}

async function fetchRoomParticipants(roomId) {
  const { data: membersData, error: membersError } = await supabaseAdmin
    .from("room_members")
    .select("room_id,user_uuid,display_name,avatar_url,joined_at")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true });

  if (!membersError && membersData) {
    return membersData.map((row) => ({
      user_uuid: row.user_uuid,
      display_name: row.display_name,
      avatar_url: row.avatar_url || null,
    }));
  }

  return [];
}

async function fetchListOpenings(listId) {
  const { data, error } = await supabaseAdmin
    .from("list_openings")
    .select("id,order_index,youtube_video_id,anime_title,opening_label")
    .eq("list_id", listId)
    .order("order_index", { ascending: true });

  if (error) {
    throw new Error(error.message || "Could not load list openings");
  }

  return data || [];
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
  if (error) {
    throw new Error(error.message || "Could not upsert room membership");
  }
}

app.use(cors({ origin: clientOrigin, credentials: true }));
app.use((req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
});

app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
}));

app.use((req, _res, next) => {
  logEvent("info", "http_request", {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
  });
  next();
});

app.use(morgan("tiny"));

app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500) {
      logEvent("error", "http_response_error", {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        error: body?.error || "unknown",
      });
      return originalJson({ error: "Internal server error" });
    }
    return originalJson(body);
  };
  next();
});

app.use("/api/auth", authLimiter);
app.use("/api/jikan", externalApiLimiter);
app.use("/api/youtube", externalApiLimiter);
app.use("/api/admin", adminLimiter);

app.get("/api/health", async (req, res) => {
  const checks = {
    supabase: false,
    youtubeApiKey: Boolean(String(process.env.YOUTUBE_API_KEY || "").trim()),
    partykitSecrets: Boolean(PARTYKIT_INTERNAL_SECRET && PARTYKIT_API_SIGNING_SECRET),
  };

  try {
    if (ensureSupabase(res)) {
      const { error } = await supabaseAdmin.from("app_users").select("id").limit(1);
      checks.supabase = !error;
    }
  } catch (error) {
    logEvent("error", "health_supabase_failed", {
      requestId: req.requestId,
      error: String(error?.message || error),
    });
  }

  const ok = checks.supabase && checks.partykitSecrets;
  res.status(ok ? 200 : 503).json({ ok, ts: Date.now(), checks });
});

app.post("/api/internal/auth/session/verify", async (req, res) => {
  if (!ensureSupabase(res)) return;
  if (!ensureInternalPartykit(req, res)) return;

  const token = String(req.body?.token || "").trim();
  if (!token) {
    return res.status(400).json({ error: "Missing session token" });
  }

  try {
    const { data: session, error: sessionError } = await supabaseAdmin
      .from("app_user_sessions")
      .select("token,user_id,expires_at")
      .eq("token", token)
      .maybeSingle();

    if (sessionError || !session) {
      return res.status(401).json({ error: "Invalid session token" });
    }

    const expired = new Date(session.expires_at).getTime() <= Date.now();
    if (expired) {
      await supabaseAdmin.from("app_user_sessions").delete().eq("token", token);
      return res.status(401).json({ error: "Session expired" });
    }

    const { data: user, error: userError } = await supabaseAdmin
      .from("app_users")
      .select("id,username,display_name,avatar_url,role")
      .eq("id", session.user_id)
      .maybeSingle();

    if (userError || !user) {
      return res.status(401).json({ error: "Invalid session user" });
    }

    return res.json({ user: mapUser(user), expiresAt: session.expires_at });
  } catch (error) {
    return internalError(req, res, error, "internal_auth_verify_failed");
  }
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

app.get("/api/lists", async (req, res) => {
  if (!ensureSupabase(res)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;

  let query = supabaseAdmin
    .from("lists")
    .select("id,name,is_preset,list_source,created_at,created_by")
    .order("created_at", { ascending: false });

  if (auth.user.role === "admin") {
    query = query.limit(500);
  } else {
    query = query.or(`is_preset.eq.true,created_by.eq.${auth.user.id}`).limit(200);
  }

  const { data, error } = await query;

  if (error) return internalError(req, res, error, "lists_fetch_failed");
  return res.json({ lists: data || [] });
});

app.get("/api/lists/:listId/openings", async (req, res) => {
  if (!ensureSupabase(res)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const listId = parseSchema(ListIdSchema, String(req.params.listId || ""), res, "Invalid listId");
  if (!listId) return;

  const { data: list, error: listError } = await supabaseAdmin
    .from("lists")
    .select("id,created_by,is_preset")
    .eq("id", listId)
    .maybeSingle();

  if (listError) return internalError(req, res, listError, "list_openings_owner_check_failed");
  if (!list) return res.status(404).json({ error: "List not found" });

  const canRead = list.is_preset || String(list.created_by || "") === auth.user.id || auth.user.role === "admin";
  if (!canRead) return res.status(403).json({ error: "Forbidden" });

  const { data, error } = await supabaseAdmin
    .from("list_openings")
    .select("id,anime_id,anime_title,opening_label,youtube_video_id,thumbnail_url,order_index")
    .eq("list_id", listId)
    .order("order_index", { ascending: true });

  if (error) return internalError(req, res, error, "list_openings_fetch_failed");
  return res.json({ openings: data || [] });
});

app.post("/api/lists/save", async (req, res) => {
  if (!ensureSupabase(res)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const input = parseSchema(SaveListSchema, req.body || {}, res, "Invalid list payload");
  if (!input) return;

  try {
    let listId = input.listId || "";

    if (!listId) {
      const { data: created, error: createError } = await supabaseAdmin
        .from("lists")
        .insert({
          name: input.name,
          created_by: auth.user.id,
          is_preset: Boolean(input.isPreset),
          list_source: input.source,
        })
        .select("id")
        .single();

      if (createError) return internalError(req, res, createError, "list_create_failed");
      listId = created.id;
    } else {
      const { data: list, error: listError } = await supabaseAdmin
        .from("lists")
        .select("id,created_by,is_preset")
        .eq("id", listId)
        .maybeSingle();

      if (listError) return internalError(req, res, listError, "list_update_owner_check_failed");
      if (!list) return res.status(404).json({ error: "List not found" });

      const canEdit = auth.user.role === "admin" || String(list.created_by || "") === auth.user.id;
      if (!canEdit) return res.status(403).json({ error: "Forbidden" });

      const { error: renameError } = await supabaseAdmin
        .from("lists")
        .update({ name: input.name, is_preset: Boolean(input.isPreset), list_source: input.source })
        .eq("id", listId);

      if (renameError) return internalError(req, res, renameError, "list_update_failed");

      const { error: deleteError } = await supabaseAdmin
        .from("list_openings")
        .delete()
        .eq("list_id", listId);

      if (deleteError) return internalError(req, res, deleteError, "list_openings_clear_failed");
    }

    const rows = input.openings.map((opening, index) => ({
      list_id: listId,
      anime_id: opening.anime_id,
      anime_title: opening.anime_title,
      opening_label: opening.opening_label,
      youtube_video_id: String(opening.youtube_video_id || "").trim() || null,
      thumbnail_url: String(opening.thumbnail_url || "").trim() || null,
      order_index: index,
    }));

    const { error: insertError } = await supabaseAdmin.from("list_openings").insert(rows);
    if (insertError) return internalError(req, res, insertError, "list_openings_insert_failed");

    return res.status(201).json({ list: { id: listId, name: input.name } });
  } catch (error) {
    return internalError(req, res, error, "list_save_failed");
  }
});

app.post("/api/lists/import-youtube-playlist", async (req, res) => {
  if (!ensureSupabase(res)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const input = parseSchema(ImportYoutubePlaylistSchema, req.body || {}, res, "Invalid playlist payload");
  if (!input) return;

  try {
    const imported = await importYoutubePlaylist(input.playlistUrl, input.limit || 150);
    if (!imported.items?.length) {
      return res.status(400).json({ error: "Playlist has no public videos to import" });
    }

    const finalName =
      String(input.listName || "").trim() ||
      imported.playlistTitle ||
      "YouTube Playlist";

    const { data: createdList, error: listError } = await supabaseAdmin
      .from("lists")
      .insert({
        name: finalName,
        created_by: auth.user.id,
        is_preset: false,
        list_source: "youtube",
      })
      .select("id,name")
      .single();

    if (listError) return internalError(req, res, listError, "youtube_playlist_list_create_failed");

    const rows = imported.items.map((item, index) => ({
      list_id: createdList.id,
      anime_id: index + 1,
      anime_title: item.title,
      opening_label: item.channelTitle || "YouTube",
      youtube_video_id: item.videoId,
      thumbnail_url: item.thumbnailUrl || null,
      order_index: index,
    }));

    const { error: insertError } = await supabaseAdmin.from("list_openings").insert(rows);
    if (insertError) return internalError(req, res, insertError, "youtube_playlist_openings_insert_failed");

    return res.status(201).json({
      list: {
        id: createdList.id,
        name: createdList.name,
        source: "youtube",
        count: rows.length,
      },
    });
  } catch (error) {
    return internalError(req, res, error, "youtube_playlist_import_failed");
  }
});

app.delete("/api/lists/:listId", async (req, res) => {
  if (!ensureSupabase(res)) return;
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const listId = parseSchema(ListIdSchema, String(req.params.listId || ""), res, "Invalid listId");
  if (!listId) return;

  const { data: list, error: listError } = await supabaseAdmin
    .from("lists")
    .select("id,created_by")
    .eq("id", listId)
    .maybeSingle();

  if (listError) return internalError(req, res, listError, "list_delete_owner_check_failed");
  if (!list) return res.status(404).json({ error: "List not found" });

  const canDelete = auth.user.role === "admin" || String(list.created_by || "") === auth.user.id;
  if (!canDelete) return res.status(403).json({ error: "Forbidden" });

  const { error } = await supabaseAdmin.from("lists").delete().eq("id", listId);
  if (error) return internalError(req, res, error, "list_delete_failed");
  return res.status(204).send();
});

app.post("/api/admin/import/top-mal-openings", async (req, res) => {
  if (!ensureSupabase(res)) return;
  const admin = await requireAdmin(req, res);
  if (!admin) return;

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
  const admin = await requireAdmin(req, res);
  if (!admin) return;

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

app.get("/api/internal/rooms/:roomId/state", async (req, res) => {
  if (!ensureSupabase(res)) return;
  if (!ensureInternalPartykit(req, res)) return;

  const roomId = String(req.params.roomId || "").trim();
  if (!roomId) {
    return res.status(400).json({ error: "Missing room id" });
  }

  const { data: room, error: roomError } = await supabaseAdmin
    .from("rooms")
    .select("id,name,list_id,current_opening_index,status,host_uuid,owner_user_id")
    .eq("id", roomId)
    .maybeSingle();

  if (roomError) return res.status(500).json({ error: roomError.message });
  if (!room) return res.status(404).json({ error: "Room not found" });

  try {
    const openings = await fetchListOpenings(room.list_id);
    const currentOpening = openings.find((item) => item.order_index === room.current_opening_index) || null;
    const members = await fetchRoomParticipants(roomId);

    let currentOpeningRatings = [];
    if (currentOpening?.id) {
      const { data: ratingsData, error: ratingsError } = await supabaseAdmin
        .from("ratings")
        .select("user_uuid,score,list_opening_id")
        .eq("room_id", roomId)
        .eq("list_opening_id", currentOpening.id);

      if (ratingsError) {
        return res.status(500).json({ error: ratingsError.message });
      }

      currentOpeningRatings = ratingsData || [];
    }

    res.json({
      room,
      openings,
      currentOpening,
      currentOpeningRatings,
      members,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not build room state" });
  }
});

app.post("/api/internal/rooms/:roomId/host", async (req, res) => {
  if (!ensureSupabase(res)) return;
  if (!ensureInternalPartykit(req, res)) return;

  const roomId = String(req.params.roomId || "").trim();
  const hostUuid = String(req.body?.hostUuid || "").trim();

  if (!roomId || !hostUuid) {
    return res.status(400).json({ error: "Missing roomId or hostUuid" });
  }

  const { data, error } = await supabaseAdmin
    .from("rooms")
    .update({ host_uuid: hostUuid })
    .eq("id", roomId)
    .select("id,host_uuid")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ room: data });
});

app.post("/api/internal/rooms/:roomId/advance", async (req, res) => {
  if (!ensureSupabase(res)) return;
  if (!ensureInternalPartykit(req, res)) return;

  const roomId = String(req.params.roomId || "").trim();
  const actorUserUuid = String(req.body?.actorUserUuid || "").trim();
  const requestedIndex = Number(req.body?.targetIndex);
  const forceFinish = Boolean(req.body?.finish);

  if (!roomId || !actorUserUuid) {
    return res.status(400).json({ error: "Missing roomId or actorUserUuid" });
  }

  const { data: room, error: roomError } = await supabaseAdmin
    .from("rooms")
    .select("id,list_id,current_opening_index,status,host_uuid,owner_user_id")
    .eq("id", roomId)
    .maybeSingle();

  if (roomError) return res.status(500).json({ error: roomError.message });
  if (!room) return res.status(404).json({ error: "Room not found" });

  const canAct =
    String(room.host_uuid || "") === actorUserUuid ||
    String(room.owner_user_id || "") === actorUserUuid;

  if (!canAct) {
    return res.status(403).json({ error: "Only host or owner can advance openings" });
  }

  try {
    const openings = await fetchListOpenings(room.list_id);
    if (openings.length === 0) {
      return res.status(400).json({ error: "No openings in room list" });
    }

    const lastIndex = openings.length - 1;
    const previousOpeningIndex = Number(room.current_opening_index || 0);
    const fallbackIndex = previousOpeningIndex + 1;
    const targetIndex = Number.isInteger(requestedIndex) ? requestedIndex : fallbackIndex;
    const shouldFinish = forceFinish || targetIndex > lastIndex || previousOpeningIndex >= lastIndex;

    if (shouldFinish) {
      const { data: finishedRoom, error: finishedError } = await supabaseAdmin
        .from("rooms")
        .update({
          status: "finished",
          current_opening_index: Math.max(0, Math.min(previousOpeningIndex, lastIndex)),
        })
        .eq("id", roomId)
        .select("id,status,current_opening_index,host_uuid")
        .single();

      if (finishedError) return res.status(500).json({ error: finishedError.message });

      return res.json({
        room: finishedRoom,
        previousOpeningIndex,
        nextOpening: null,
      });
    }

    const safeTargetIndex = Math.max(0, Math.min(lastIndex, targetIndex));
    const nextOpening = openings.find((item) => item.order_index === safeTargetIndex) || null;

    const { data: updatedRoom, error: updateError } = await supabaseAdmin
      .from("rooms")
      .update({
        status: "playing",
        current_opening_index: safeTargetIndex,
      })
      .eq("id", roomId)
      .select("id,status,current_opening_index,host_uuid")
      .single();

    if (updateError) return res.status(500).json({ error: updateError.message });

    return res.json({
      room: updatedRoom,
      previousOpeningIndex,
      nextOpening,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not advance opening" });
  }
});

app.get("/api/rooms/public", async (_, res) => {
  if (!ensureSupabase(res)) return;

  const { data, error } = await supabaseAdmin
    .from("rooms")
    .select("id,name,is_public,invite_code,current_opening_index,status,created_at,owner_user_id,lists(name)")
    .eq("is_public", true)
    .in("status", ["waiting", "playing"])
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ rooms: data || [] });
});

app.get("/api/rooms/by-code/:code", joinByCodeLimiter, async (req, res) => {
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

app.post("/api/rooms/:roomId/presence", async (req, res) => {
  if (!ensureSupabase(res)) return;

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const roomId = parseSchema(RoomIdSchema, String(req.params.roomId || ""), res, "Invalid roomId");
  if (!roomId) return;

  try {
    await upsertRoomMembership(roomId, auth.user);
    return res.status(204).send();
  } catch (error) {
    return internalError(req, res, error, "room_presence_upsert_failed");
  }
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

  const roomId = parseSchema(RoomIdSchema, String(req.body?.roomId || "").trim(), res, "Invalid roomId");
  const status = parseSchema(RoomStatusSchema, String(req.body?.status || "").trim(), res, "Invalid status");

  if (!roomId || !status) {
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

  const roomId = parseSchema(RoomIdSchema, String(req.body?.roomId || "").trim(), res, "Invalid roomId");
  const openingId = parseSchema(z.string().uuid(), String(req.body?.openingId || "").trim(), res, "Invalid openingId");
  const score = parseSchema(ScoreSchema, Number(req.body?.score), res, "Invalid score");

  if (!roomId || !openingId || !score) {
    return res.status(400).json({ error: "Invalid rating payload" });
  }

  const { data: room, error: roomError } = await supabaseAdmin
    .from("rooms")
    .select("id,list_id,status,current_opening_index")
    .eq("id", roomId)
    .maybeSingle();

  if (roomError) return res.status(500).json({ error: roomError.message });
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.status !== "playing") {
    return res.status(409).json({ error: "Room is not currently accepting ratings" });
  }

  const { data: opening, error: openingError } = await supabaseAdmin
    .from("list_openings")
    .select("id,order_index")
    .eq("id", openingId)
    .eq("list_id", room.list_id)
    .maybeSingle();

  if (openingError) return res.status(500).json({ error: openingError.message });
  if (!opening) {
    return res.status(400).json({ error: "Opening does not belong to this room list" });
  }

  // Ratings are only writable for the room's currently active opening.
  if (opening.order_index !== room.current_opening_index) {
    return res.status(409).json({ error: "Ratings for this opening are locked" });
  }

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

  const roomId = parseSchema(RoomIdSchema, String(req.params.roomId || ""), res, "Invalid roomId");
  if (!roomId) return;
  const parsedIndex = Number(req.body?.nextIndex);

  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    return res.status(400).json({ error: "Invalid nextIndex" });
  }

  const { data: room, error: roomError } = await supabaseAdmin
    .from("rooms")
    .select("id,owner_user_id,host_uuid,status,list_id")
    .eq("id", roomId)
    .single();

  if (roomError) return res.status(500).json({ error: roomError.message });
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (!canControlRoom(auth.user, room)) {
    return res.status(403).json({ error: "Only the host/owner or admin can change the opening" });
  }

  const openings = await fetchListOpenings(room.list_id);
  if (openings.length === 0) {
    return res.status(400).json({ error: "This room list has no openings" });
  }

  const maxIndex = openings.length - 1;
  if (parsedIndex > maxIndex) {
    return res.status(400).json({ error: `nextIndex is out of range (0-${maxIndex})` });
  }

  const { data, error } = await supabaseAdmin
    .from("rooms")
    .update({ current_opening_index: parsedIndex, status: "playing" })
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

  const roomId = parseSchema(RoomIdSchema, String(req.params.roomId || ""), res, "Invalid roomId");
  if (!roomId) return;
  const parsedIndex = Number(req.body?.openingIndex);

  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
    return res.status(400).json({ error: "Invalid openingIndex" });
  }

  const { data: room, error: roomError } = await supabaseAdmin
    .from("rooms")
    .select("id,owner_user_id,host_uuid,list_id")
    .eq("id", roomId)
    .single();

  if (roomError) return res.status(500).json({ error: roomError.message });
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (!canControlRoom(auth.user, room)) {
    return res.status(403).json({ error: "Only the host/owner or admin can change the opening" });
  }

  const openings = await fetchListOpenings(room.list_id);
  if (openings.length === 0) {
    return res.status(400).json({ error: "This room list has no openings" });
  }

  const maxIndex = openings.length - 1;
  if (parsedIndex > maxIndex) {
    return res.status(400).json({ error: `openingIndex is out of range (0-${maxIndex})` });
  }

  const { data, error } = await supabaseAdmin
    .from("rooms")
    .update({ current_opening_index: parsedIndex, status: "playing" })
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

  const roomId = parseSchema(RoomIdSchema, String(req.params.roomId || ""), res, "Invalid roomId");
  if (!roomId) return;

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

  const roomId = parseSchema(RoomIdSchema, String(req.params.roomId || ""), res, "Invalid roomId");
  if (!roomId) return;

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
const isVercel = Boolean(process.env.VERCEL);

if (process.env.NODE_ENV === "production" && !isVercel) {
  app.use(express.static(clientDist));
  app.get("*", (_, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

if (!isVercel) {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`API running on http://localhost:${port}`);
  });
}

export default app;
