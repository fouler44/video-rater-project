import { cache } from "./cache.js";

const JIKAN_BASE = "https://api.jikan.moe/v4";
const YOUTUBE_BASE = "https://www.googleapis.com/youtube/v3/search";
const YOUTUBE_VIDEOS_BASE = "https://www.googleapis.com/youtube/v3/videos";
const YOUTUBE_PLAYLIST_ITEMS_BASE = "https://www.googleapis.com/youtube/v3/playlistItems";
const YOUTUBE_PLAYLISTS_BASE = "https://www.googleapis.com/youtube/v3/playlists";
const PREFERRED_CHANNELS = [
  "crunchyroll",
  "aniplex",
  "toho animation",
  "funimation",
  "kadokawa anime",
  "netflix anime",
  "animeonegai",
];

const TOP_ANIME_IMPORT_MAX = 300;
const MAX_OPENINGS_PER_ANIME = 6;

async function fetchJson(url) {
  const cached = cache.get(url);
  if (cached) return cached;

  const maxRetries = 4;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) {
      const json = await response.json();
      cache.set(url, json);
      return json;
    }

    const body = await response.text();
    if (response.status === 429 && attempt < maxRetries) {
      const retryAfterHeader = Number(response.headers.get("retry-after") || 0);
      const retryMs = retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : Math.min(10000, 1200 * (attempt + 1));
      await delay(retryMs);
      continue;
    }

    throw new Error(`${response.status} ${response.statusText} - ${body}`);
  }

  throw new Error("Unexpected fetch retry flow");
}

function delay(ms = 0) {
  const safeMs = Math.max(0, Number(ms) || 0);
  if (safeMs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, safeMs);
  });
}

function extractYoutubePlaylistId(input = "") {
  const raw = String(input || "").trim();
  if (!raw) return "";

  if (/^[a-zA-Z0-9_-]{10,60}$/.test(raw) && raw.startsWith("PL")) {
    return raw;
  }

  try {
    const parsed = new URL(raw);
    const list = parsed.searchParams.get("list");
    return String(list || "").trim();
  } catch {
    return "";
  }
}

export async function getTopAnime(limit = 25, source = "score") {
  const safeLimit = Math.max(1, Math.min(300, Number(limit) || 25));
  const topBy = source === "popular" ? "popular" : "score";
  const chunks = [];
  let page = 1;

  while (chunks.length < safeLimit) {
    const remaining = safeLimit - chunks.length;
    const pageLimit = Math.min(25, remaining);
    const filter = topBy === "popular" ? "&filter=bypopularity" : "";
    const url = `${JIKAN_BASE}/top/anime?limit=${pageLimit}&page=${page}${filter}`;
    const pageData = await fetchJson(url);
    const scoped = pageData?.data || [];

    if (scoped.length === 0) break;
    chunks.push(...scoped);

    if (scoped.length < pageLimit) break;
    page += 1;
  }

  return { data: chunks.slice(0, safeLimit) };
}

export async function searchAnime(query) {
  const q = encodeURIComponent(query || "");
  const url = `${JIKAN_BASE}/anime?q=${q}&limit=20`;
  return fetchJson(url);
}

export async function getAnimeThemes(animeId) {
  const safeAnimeId = Number(animeId);
  if (!Number.isFinite(safeAnimeId) || safeAnimeId <= 0) {
    throw new Error("Invalid anime id");
  }

  const url = `${JIKAN_BASE}/anime/${safeAnimeId}/themes`;
  return fetchJson(url);
}

function sanitizeOpeningLabel(value) {
  if (!value) return "OP1";
  return String(value).replace(/^\d+\s*[:-]\s*/g, "").trim();
}

function parseIso8601DurationToSeconds(iso = "") {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(iso);
  if (!match) return 0;

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function formatSeconds(seconds = 0) {
  const safe = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function estimateOpeningStartSeconds(durationSeconds = 0) {
  const safeDuration = Math.max(0, Number(durationSeconds) || 0);
  if (safeDuration <= 0) return 0;

  const estimatedHook = Math.round(safeDuration * 0.64);
  return Math.max(0, estimatedHook - 6);
}

function computeYoutubeScore(video, rawQuery = "") {
  const title = String(video?.snippet?.title || "").toLowerCase();
  const channel = String(video?.snippet?.channelTitle || "").toLowerCase();
  const query = String(rawQuery || "").toLowerCase();
  const durationSeconds = Number(video?.durationSeconds || 0);

  let score = 0;

  if (title.includes("opening") || title.includes("op ") || title.includes(" op")) score += 30;
  if (title.includes("creditless")) score += 18;
  if (title.includes("tv size") || title.includes("tv ver") || title.includes("tv version")) score += 22;
  if (title.includes("official")) score += 12;

  if (query.includes("op") || query.includes("opening")) score += 6;

  const matchedChannelIndex = PREFERRED_CHANNELS.findIndex((name) => channel.includes(name));
  if (matchedChannelIndex >= 0) {
    score += 45 - matchedChannelIndex * 4;
  }

  if (durationSeconds > 0) {
    // Favorece ~1:30, con un margen útil para openings TV size
    const deltaFromIdeal = Math.abs(durationSeconds - 90);
    const durationScore = Math.max(0, 28 - deltaFromIdeal / 2);
    score += durationScore;

    if (durationSeconds >= 70 && durationSeconds <= 110) score += 12;
    if (durationSeconds >= 60 && durationSeconds <= 150) score += 8;
    if (durationSeconds > 210) score -= 22;
  }

  return score;
}

export async function searchYoutube(query) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY missing");
  }

  const q = encodeURIComponent(query || "anime opening");
  const searchUrl = `${YOUTUBE_BASE}?part=snippet&type=video&maxResults=15&videoDuration=short&videoEmbeddable=true&videoSyndicated=true&safeSearch=none&order=relevance&q=${q}&key=${apiKey}`;
  const searchData = await fetchJson(searchUrl);

  const videoIds = (searchData.items || [])
    .map((item) => item?.id?.videoId)
    .filter(Boolean);

  if (videoIds.length === 0) {
    return { ...searchData, items: [] };
  }

  const videosUrl = `${YOUTUBE_VIDEOS_BASE}?part=contentDetails,snippet&id=${videoIds.join(",")}&key=${apiKey}`;
  const videosData = await fetchJson(videosUrl);

  const detailsById = new Map((videosData.items || []).map((item) => [item.id, item]));

  const rankedItems = (searchData.items || [])
    .map((item) => {
      const videoId = item?.id?.videoId;
      const details = detailsById.get(videoId);
      const durationIso = details?.contentDetails?.duration || "";
      const durationSeconds = parseIso8601DurationToSeconds(durationIso);
      const score = computeYoutubeScore(
        {
          ...item,
          durationSeconds,
        },
        query,
      );

      return {
        ...item,
        durationSeconds,
        durationText: formatSeconds(durationSeconds),
        rankScore: Number(score.toFixed(2)),
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 10);

  return {
    ...searchData,
    items: rankedItems,
  };
}

export async function buildPresetTopOpenings(limit = 20, source = "score") {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const safeSource = source === "popular" ? "popular" : "score";
  const top = await getTopAnime(safeLimit, safeSource);
  const animeList = top.data || [];

  const openings = [];
  for (const anime of animeList) {
    const animeTitle = anime.title_english || anime.title;
    try {
      const themes = await getAnimeThemes(anime.mal_id);
      const openingLabels = (themes?.data?.openings || [])
        .map((label) => sanitizeOpeningLabel(label))
        .filter(Boolean);

      const labelsToUse = openingLabels.length > 0 ? openingLabels : ["OP1"];

      for (const openingLabel of labelsToUse) {
        const query = `${animeTitle} ${openingLabel} anime opening official crunchyroll tv size 1:30`;

        let youtubeVideoId = "";
        let thumbnailUrl = "";
        let first = null;

        try {
          const youtube = await searchYoutube(query);
          first = youtube.items?.[0] || null;
          youtubeVideoId = first?.id?.videoId || "";
          thumbnailUrl =
            first?.snippet?.thumbnails?.medium?.url || anime.images?.jpg?.image_url || "";
        } catch {
          thumbnailUrl = anime.images?.jpg?.image_url || "";
        }

        openings.push({
          anime_id: anime.mal_id,
          anime_title: animeTitle,
          opening_label: openingLabel,
          youtube_video_id: youtubeVideoId,
          thumbnail_url: thumbnailUrl,
          order_index: openings.length,
        });
      }
    } catch {
      const openingLabel = "OP1";
      const query = `${animeTitle} ${openingLabel} anime opening official crunchyroll tv size 1:30`;

      let youtubeVideoId = "";
      let thumbnailUrl = "";
      let first = null;

      try {
        const youtube = await searchYoutube(query);
        first = youtube.items?.[0] || null;
        youtubeVideoId = first?.id?.videoId || "";
        thumbnailUrl =
          first?.snippet?.thumbnails?.medium?.url || anime.images?.jpg?.image_url || "";
      } catch {
        thumbnailUrl = anime.images?.jpg?.image_url || "";
      }

      openings.push({
        anime_id: anime.mal_id,
        anime_title: animeTitle,
        opening_label: openingLabel,
        youtube_video_id: youtubeVideoId,
        thumbnail_url: thumbnailUrl,
        order_index: openings.length,
      });
    }
  }

  return openings;
}

export async function importYoutubePlaylist(playlistInput, limit = 150) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY missing");
  }

  const playlistId = extractYoutubePlaylistId(playlistInput);
  if (!playlistId) {
    throw new Error("Invalid YouTube playlist URL");
  }

  const safeLimit = Math.max(1, Math.min(300, Number(limit) || 150));
  const encodedPlaylistId = encodeURIComponent(playlistId);
  const playlistMetaUrl = `${YOUTUBE_PLAYLISTS_BASE}?part=snippet&id=${encodedPlaylistId}&maxResults=1&key=${apiKey}`;
  const playlistMeta = await fetchJson(playlistMetaUrl);
  const playlistTitle = String(playlistMeta?.items?.[0]?.snippet?.title || "").trim();

  const items = [];
  let nextPageToken = "";

  while (items.length < safeLimit) {
    const remaining = safeLimit - items.length;
    const pageSize = Math.min(50, remaining);
    const pageTokenParam = nextPageToken ? `&pageToken=${encodeURIComponent(nextPageToken)}` : "";
    const pageUrl = `${YOUTUBE_PLAYLIST_ITEMS_BASE}?part=snippet&playlistId=${encodedPlaylistId}&maxResults=${pageSize}${pageTokenParam}&key=${apiKey}`;
    const page = await fetchJson(pageUrl);
    const pageItems = page?.items || [];

    for (const item of pageItems) {
      const snippet = item?.snippet || {};
      const resource = snippet?.resourceId || {};
      const videoId = String(resource?.videoId || "").trim();
      if (!videoId) continue;

      const title = String(snippet?.title || "").trim();
      if (!title || title.toLowerCase() === "private video" || title.toLowerCase() === "deleted video") {
        continue;
      }

      items.push({
        videoId,
        title,
        channelTitle: String(snippet?.videoOwnerChannelTitle || snippet?.channelTitle || "").trim(),
        thumbnailUrl:
          snippet?.thumbnails?.medium?.url ||
          snippet?.thumbnails?.high?.url ||
          snippet?.thumbnails?.default?.url ||
          "",
      });

      if (items.length >= safeLimit) break;
    }

    nextPageToken = String(page?.nextPageToken || "").trim();
    if (!nextPageToken || pageItems.length === 0) break;
  }

  const deduped = [];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.videoId)) continue;
    seen.add(item.videoId);
    deduped.push(item);
  }

  return {
    playlistId,
    playlistTitle,
    items: deduped,
  };
}

export async function buildMalTopOpeningsDataset(options = {}) {
  const safeLimit = Math.max(1, Math.min(TOP_ANIME_IMPORT_MAX, Number(options.topLimit) || 300));
  const safeSource = options.source === "score" ? "score" : "popular";
  const includeYoutube = Boolean(options.includeYoutube);
  const themeDelayMs = Math.max(0, Number(options.themeDelayMs) || 350);
  const youtubeDelayMs = Math.max(0, Number(options.youtubeDelayMs) || 175);
  const safeOpeningsPerAnime = Math.max(
    1,
    Math.min(MAX_OPENINGS_PER_ANIME, Number(options.maxOpeningsPerAnime) || MAX_OPENINGS_PER_ANIME),
  );

  const top = await getTopAnime(safeLimit, safeSource);
  const animeList = top.data || [];
  const openings = [];

  for (const anime of animeList) {
    const animeTitle = anime.title_english || anime.title;
    let openingLabels = [];

    try {
      const themes = await getAnimeThemes(anime.mal_id);
      openingLabels = (themes?.data?.openings || [])
        .map((label) => sanitizeOpeningLabel(label))
        .filter(Boolean);
    } catch {
      openingLabels = [];
    }

    const labelsToUse = (openingLabels.length > 0 ? openingLabels : ["OP1"])
      .filter((label, index, arr) => arr.indexOf(label) === index)
      .slice(0, safeOpeningsPerAnime);

    for (const openingLabel of labelsToUse) {
      let youtubeVideoId = "";
      let thumbnailUrl = anime.images?.jpg?.image_url || "";

      if (includeYoutube) {
        const query = `${animeTitle} ${openingLabel} anime opening official crunchyroll tv size 1:30`;
        try {
          const youtube = await searchYoutube(query);
          const first = youtube.items?.[0] || null;
          youtubeVideoId = first?.id?.videoId || "";
          thumbnailUrl = first?.snippet?.thumbnails?.medium?.url || thumbnailUrl;
        } catch {
          // Leave fields with fallback values when YouTube lookup fails.
        }

        if (youtubeDelayMs > 0) {
          await delay(youtubeDelayMs);
        }
      }

      openings.push({
        anime_id: anime.mal_id,
        anime_title: animeTitle,
        opening_label: openingLabel,
        youtube_video_id: youtubeVideoId,
        thumbnail_url: thumbnailUrl,
      });
    }

    if (themeDelayMs > 0) {
      await delay(themeDelayMs);
    }
  }

  return openings;
}
