import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiDelete, apiPost } from "../lib/api";
import { APP_ENV } from "../lib/env";
import { getDefaultAvatar, getIdentity } from "../lib/identity";
import { supabase } from "../lib/supabase";
import { clearPendingRoomTransition, readPendingRoomTransition } from "../lib/viewTransition";
import {
  Users,
  Play,
  SkipForward,
  Volume2,
  VolumeX,
  Trophy,
  Trash2,
  ListMusic,
  CheckCircle2,
  AlertTriangle,
  X,
  ChevronLeft,
  RefreshCw,
} from "lucide-react";

const PARTYKIT_URL = APP_ENV.partykitUrl;
const OPENING_GRACE_MS = 2500;
const DRIFT_THRESHOLD_SECONDS = 3;
const HOST_SYNC_INTERVAL_MS = 12000;
const PARTY_HEARTBEAT_MS = 20000;

let youtubeIframePromise = null;

function isValidRatingValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return false;
  if (numeric < 1 || numeric > 10) return false;
  return Math.abs(numeric * 2 - Math.round(numeric * 2)) < 1e-9;
}

function normalizeRatingValue(value, fallback = 5) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;

  const clamped = Math.max(1, Math.min(10, numeric));
  const halfStep = Math.round(clamped * 2) / 2;
  return Number(halfStep.toFixed(1));
}

function isInRatingRange(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 && numeric <= 10;
}

function formatRatingValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1);
}

function formatAverageRatingValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(2).replace(/(\.\d)0$/, "$1");
}

function formatAnimeTitleWithTheme(opening) {
  const animeTitle = String(opening?.anime_title || "").trim();
  const themeKind = String(opening?.theme_kind || "").trim();

  if (!animeTitle) return themeKind || "Unknown anime";
  if (!themeKind) return animeTitle;

  return `${animeTitle} (${themeKind})`;
}

function ensureYoutubeIframeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeIframePromise) return youtubeIframePromise;

  youtubeIframePromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (!existingScript) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => reject(new Error("Could not load YouTube iframe API"));
      document.head.appendChild(script);
    }

    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousReady === "function") previousReady();
      resolve(window.YT);
    };

    const maxWaitMs = 15000;
    const startedAt = Date.now();
    const poll = () => {
      if (window.YT?.Player) {
        resolve(window.YT);
        return;
      }
      if (Date.now() - startedAt > maxWaitMs) {
        reject(new Error("Timed out waiting for YouTube iframe API"));
        return;
      }
      window.setTimeout(poll, 120);
    };

    poll();
  });

  return youtubeIframePromise;
}

function normalizeParticipantRow(row) {
  const name = row.user_name || row.display_name || "Anon";
  return {
    id: row.id || `${row.room_id || "room"}:${row.user_uuid}`,
    user_uuid: row.user_uuid,
    user_name: name,
    avatar_url: row.avatar_url || getDefaultAvatar(name),
  };
}

function buildPartySocketUrl(roomId, identity) {
  const normalizedBase = String(PARTYKIT_URL)
    .replace(/^http:/i, "ws:")
    .replace(/^https:/i, "wss:")
    .replace(/\/$/, "");

  const query = new URLSearchParams({
    sessionToken: identity.token,
  });

  return `${normalizedBase}/parties/main/${roomId}?${query.toString()}`;
}

function upsertVote(votes, nextVote) {
  const found = votes.some((item) => item.user_uuid === nextVote.user_uuid);
  if (!found) {
    return [...votes, { user_uuid: nextVote.user_uuid, score: nextVote.score }];
  }

  return votes.map((item) => {
    if (item.user_uuid !== nextVote.user_uuid) return item;
    return {
      ...item,
      score: nextVote.score,
    };
  });
}

function hasNumericValue(value) {
  return Number.isFinite(Number(value));
}

export default function RoomPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const identity = getIdentity();

  const [room, setRoom] = useState(null);
  const [openings, setOpenings] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [partyMembers, setPartyMembers] = useState([]);
  const [connectedUserUuids, setConnectedUserUuids] = useState([]);

  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [shuffleLoading, setShuffleLoading] = useState(false);
  const [partyConnected, setPartyConnected] = useState(false);
  const [partyError, setPartyError] = useState("");

  const [myRating, setMyRating] = useState(0);
  const [sliderRating, setSliderRating] = useState(5);
  const [currentOpeningVotes, setCurrentOpeningVotes] = useState([]);
  const [roomUserStats, setRoomUserStats] = useState({});
  const [hostUuid, setHostUuid] = useState("");

  const [graceUntilTs, setGraceUntilTs] = useState(0);
  const [tickNow, setTickNow] = useState(Date.now());

  const [playerReady, setPlayerReady] = useState(false);
  const [desiredVideoVersion, setDesiredVideoVersion] = useState(0);
  const [playerIsPlaying, setPlayerIsPlaying] = useState(false);
  const [playerVolume, setPlayerVolume] = useState(80);
  const [playerMuted, setPlayerMuted] = useState(false);
  const [volumePanelOpen, setVolumePanelOpen] = useState(false);
  const [playerError, setPlayerError] = useState("");
  const [uiNotice, setUiNotice] = useState(null);
  const [participantsExpanded, setParticipantsExpanded] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [hostToolsExpanded, setHostToolsExpanded] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: "",
    message: "",
    confirmLabel: "Confirm",
    danger: false,
  });
  const [entryTransitionName, setEntryTransitionName] = useState(() => readPendingRoomTransition());

  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const pendingSkipRef = useRef(null);
  const reconnectAttemptRef = useRef(0);

  const roomRef = useRef(room);
  const currentOpeningRef = useRef(null);
  const isHostRef = useRef(false);
  const playerReadyRef = useRef(false);
  const expectedRemotePlaybackRef = useRef(false);
  const lastIncomingPlayerStateRef = useRef(null);

  const playerRef = useRef(null);
  const playerContainerRef = useRef(null);
  const currentVideoIdRef = useRef("");
  const desiredVideoRef = useRef(null);
  const confirmResolverRef = useRef(null);
  const nativeControlsRef = useRef(false);

  // Guard against host replay loops: state changes caused by remote sync should not be re-broadcast.
  const remotePlayerMutationUntilRef = useRef(0);

  useEffect(() => {
    if (!entryTransitionName) {
      clearPendingRoomTransition();
      return;
    }

    const timeout = window.setTimeout(() => {
      setEntryTransitionName("");
      clearPendingRoomTransition();
    }, 760);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [entryTransitionName]);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  const mergedParticipants = useMemo(() => {
    const map = new Map();

    for (const participant of participants) {
      map.set(participant.user_uuid, participant);
    }

    for (const partyMember of partyMembers) {
      const userUuid = String(partyMember.userUuid || "").trim();
      if (!userUuid) continue;

      const existing = map.get(userUuid);
      const displayName = String(partyMember.displayName || existing?.user_name || "Anon").trim() || "Anon";
      const avatar = String(partyMember.avatarUrl || existing?.avatar_url || "").trim();

      map.set(userUuid, {
        id: existing?.id || `${roomId}:${userUuid}`,
        user_uuid: userUuid,
        user_name: displayName,
        avatar_url: avatar || getDefaultAvatar(displayName),
      });
    }

    return Array.from(map.values());
  }, [participants, partyMembers, roomId]);

  const currentOpening = useMemo(() => {
    if (!room || !openings.length) return null;
    return openings.find((item) => item.order_index === room.current_opening_index) || null;
  }, [room, openings]);

  useEffect(() => {
    currentOpeningRef.current = currentOpening;
  }, [currentOpening]);

  const isHost = Boolean(identity?.userId && hostUuid && identity.userId === hostUuid);

  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);

  useEffect(() => {
    playerReadyRef.current = playerReady;
  }, [playerReady]);

  function isPlayerApiReady(player) {
    return Boolean(player && typeof player.getPlayerState === "function");
  }

  function safeLoadVideoById(videoId, startSeconds = 0, { autoplay = true, trackDesired = true } = {}) {
    const player = playerRef.current;
    const normalizedVideoId = String(videoId || "").trim();
    const normalizedStartSeconds = Math.max(0, Number(startSeconds) || 0);
    const normalizedAutoplay = Boolean(autoplay);

    if (!normalizedVideoId) {
      if (trackDesired) {
        desiredVideoRef.current = null;
        setDesiredVideoVersion((value) => value + 1);
      }
      return false;
    }

    console.log("[RoomPlayer] safeLoadVideoById called:", normalizedVideoId);

    if (trackDesired) {
      desiredVideoRef.current = {
        videoId: normalizedVideoId,
        startSeconds: normalizedStartSeconds,
        autoplay: normalizedAutoplay,
      };
      setDesiredVideoVersion((value) => value + 1);
    }

    if (!isPlayerApiReady(player) || !playerReadyRef.current) {
      console.log("[RoomPlayer] player not ready, stored as desired:", normalizedVideoId);
      return false;
    }

    console.log("[RoomPlayer] direct video load", {
      videoId: normalizedVideoId,
      startSeconds: normalizedStartSeconds,
      autoplay: normalizedAutoplay,
    });
    if (normalizedAutoplay) {
      player.loadVideoById?.(normalizedVideoId, normalizedStartSeconds);
      player.playVideo?.();
    } else {
      if (typeof player.cueVideoById === "function") {
        player.cueVideoById(normalizedVideoId, normalizedStartSeconds);
      } else {
        player.loadVideoById?.(normalizedVideoId, normalizedStartSeconds);
      }
      player.pauseVideo?.();
    }

    currentVideoIdRef.current = normalizedVideoId;
    setPlayerIsPlaying(normalizedAutoplay);

    return true;
  }

  function flushDesiredVideoLoad(reason = "ready") {
    const desired = desiredVideoRef.current;
    if (!desired?.videoId) return false;

    console.log(`[RoomPlayer] flushing desired video on ${reason}:`, desired.videoId);
    return safeLoadVideoById(desired.videoId, desired.startSeconds, {
      autoplay: desired.autoplay,
      trackDesired: false,
    });
  }

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !playerReadyRef.current) return;

    const safeVolume = Math.max(0, Math.min(100, Number(playerVolume) || 0));

    if (playerMuted || safeVolume <= 0) {
      player.mute?.();
      return;
    }

    player.unMute?.();
    player.setVolume?.(safeVolume);
  }, [playerVolume, playerMuted, playerReady]);

  const votedUserSet = useMemo(
    () => new Set(currentOpeningVotes.map((row) => row.user_uuid)),
    [currentOpeningVotes],
  );

  const userScoreMap = useMemo(
    () => Object.fromEntries(currentOpeningVotes.map((row) => [row.user_uuid, row.score])),
    [currentOpeningVotes],
  );

  const roomUserAverages = useMemo(() => {
    const next = {};
    for (const [userUuid, stats] of Object.entries(roomUserStats)) {
      const avg = Number(stats?.avg);
      if (!Number.isFinite(avg)) continue;
      next[userUuid] = avg;
    }
    return next;
  }, [roomUserStats]);

  const activeUserSet = useMemo(() => new Set(connectedUserUuids), [connectedUserUuids]);

  const connectedParticipants = useMemo(
    () => mergedParticipants.filter((participant) => activeUserSet.has(participant.user_uuid)),
    [mergedParticipants, activeUserSet],
  );

  const ratedConnectedCount = useMemo(
    () => connectedParticipants.filter((participant) => votedUserSet.has(participant.user_uuid)).length,
    [connectedParticipants, votedUserSet],
  );

  const connectedUnratedParticipants = useMemo(
    () => connectedParticipants.filter((participant) => !votedUserSet.has(participant.user_uuid)),
    [connectedParticipants, votedUserSet],
  );

  const connectedCount = connectedParticipants.length;

  const currentOpeningIndex = room?.current_opening_index ?? -1;

  const featuredQueue = useMemo(() => {
    if (openings.length === 0) return [];
    if (currentOpeningIndex < 0) return openings.slice(0, 3);
    return openings.filter((opening) => {
      return (
        opening.order_index === currentOpeningIndex
        || (opening.order_index > currentOpeningIndex && opening.order_index <= currentOpeningIndex + 2)
      );
    });
  }, [openings, currentOpeningIndex]);

  const hiddenQueue = useMemo(() => {
    if (openings.length === 0) return [];
    if (currentOpeningIndex < 0) return openings.slice(3);
    return openings.filter((opening) => {
      return !(
        opening.order_index === currentOpeningIndex
        || (opening.order_index > currentOpeningIndex && opening.order_index <= currentOpeningIndex + 2)
      );
    });
  }, [openings, currentOpeningIndex]);

  const visibleQueue = useMemo(() => {
    if (queueExpanded) {
      return openings;
    }
    return featuredQueue;
  }, [queueExpanded, openings, featuredQueue]);

  const openingAverage = useMemo(() => {
    const totalVotes = currentOpeningVotes.length;
    if (!totalVotes) {
      return { value: 0, count: 0, hasVotes: false };
    }

    const totalScore = currentOpeningVotes.reduce((sum, row) => sum + Number(row.score || 0), 0);
    return {
      value: totalScore / totalVotes,
      count: totalVotes,
      hasVotes: true,
    };
  }, [currentOpeningVotes]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTickNow(Date.now());
    }, 200);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!identity) {
      navigate("/");
      return;
    }

    let disposed = false;

    async function loadRoom() {
      setLoading(true);
      try {
        const { data: roomData, error: roomError } = await supabase
          .from("rooms")
          .select("*, lists(name)")
          .eq("id", roomId)
          .single();

        if (roomError) throw roomError;

        if (!disposed) {
          setRoom(roomData);
          setHostUuid(roomData.host_uuid || "");
        }

        if (roomData.status === "finished") {
          navigate(`/room/${roomId}/rankings`, { replace: true });
          return;
        }

        const { data: openingsData, error: openingsError } = await supabase
          .from("list_openings")
          .select("*")
          .eq("list_id", roomData.list_id)
          .order("order_index", { ascending: true });

        if (openingsError) throw openingsError;

        if (!disposed) {
          setOpenings(openingsData || []);
        }

        await upsertMyPresence();
        await fetchParticipants();
      } catch (error) {
        if (!disposed) {
          showNotice(error.message || "Could not load room", "error");
          navigate("/");
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    }

    loadRoom();

    const roomSub = supabase
      .channel(`room:${roomId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
        (payload) => {
          const nextRoom = payload.new;
          setRoom((prev) => ({ ...(prev || {}), ...nextRoom }));
          setHostUuid(String(nextRoom.host_uuid || ""));

          if (nextRoom.status === "finished") {
            navigate(`/room/${roomId}/rankings`, { replace: true });
          }
        },
      )
      .subscribe();

    const participantSub = supabase
      .channel(`participants:${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_members", filter: `room_id=eq.${roomId}` },
        () => fetchParticipants(),
      )
      .subscribe();

    const ratingSub = supabase
      .channel(`ratings:${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ratings", filter: `room_id=eq.${roomId}` },
        () => {
          fetchCurrentOpeningVotes();
          fetchRoomUserAverages();
        },
      )
      .subscribe();

    return () => {
      disposed = true;
      supabase.removeChannel(roomSub);
      supabase.removeChannel(participantSub);
      supabase.removeChannel(ratingSub);
    };
  }, [roomId, navigate]);

  useEffect(() => {
    fetchCurrentOpeningVotes();
  }, [roomId, currentOpening?.id]);

  useEffect(() => {
    fetchRoomUserAverages();
  }, [roomId]);

  useEffect(() => {
    if (!identity || !currentOpening?.id) {
      setMyRating(0);
      return;
    }

    let cancelled = false;

    async function hydrateMyRating() {
      const { data } = await supabase
        .from("ratings")
        .select("score")
        .eq("room_id", roomId)
        .eq("user_uuid", identity.userId)
        .eq("list_opening_id", currentOpening.id)
        .maybeSingle();

      if (!cancelled) {
        setMyRating(Number(data?.score || 0));
      }
    }

    hydrateMyRating();

    return () => {
      cancelled = true;
    };
  }, [roomId, currentOpening?.id, identity?.userId]);

  useEffect(() => {
    setSliderRating(myRating > 0 ? normalizeRatingValue(myRating, 5) : 5);
  }, [myRating, currentOpening?.id]);

  useEffect(() => {
    if (!identity) return;

    let closedByEffect = false;
    let isCleanedUp = false;
    let activeSocket = null;

    function stopHeartbeat() {
      if (heartbeatTimerRef.current) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    }

    function startHeartbeat(socket) {
      stopHeartbeat();
      heartbeatTimerRef.current = window.setInterval(() => {
        if (closedByEffect) {
          stopHeartbeat();
          return;
        }

        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }

        socket.send(JSON.stringify({ type: "client:ping", payload: { ts: Date.now() } }));
      }, PARTY_HEARTBEAT_MS);
    }

    function connect() {
      if (closedByEffect) return;

      const existingSocket = wsRef.current;
      if (
        existingSocket
        && (
          existingSocket.readyState === WebSocket.OPEN
          || existingSocket.readyState === WebSocket.CONNECTING
        )
      ) {
        return;
      }

      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      try {
        const ws = new WebSocket(buildPartySocketUrl(roomId, identity));
        activeSocket = ws;
        wsRef.current = ws;

        ws.onopen = () => {
          if (closedByEffect) return;
          if (wsRef.current !== ws) return;
          if (isCleanedUp) {
            ws.close();
            return;
          }

          reconnectAttemptRef.current = 0;
          if (reconnectTimerRef.current) {
            window.clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }

          setPartyConnected(true);
          setPartyError("");
          startHeartbeat(ws);
          sendPartyEvent("room:request-state", {});
        };

        ws.onmessage = (event) => {
          if (closedByEffect) return;
          if (wsRef.current !== ws) return;

          let envelope;
          try {
            envelope = JSON.parse(String(event.data || "{}"));
          } catch {
            return;
          }

          handlePartyEvent(envelope);
        };

        ws.onclose = (event) => {
          const isActiveSocket = wsRef.current === ws;
          if (isActiveSocket) {
            wsRef.current = null;
          }

          if (!isActiveSocket) {
            return;
          }

          stopHeartbeat();

          setPartyConnected(false);

          if (event?.code === 4401) {
            setPartyError("Session expired. Please log in again.");
            return;
          }

          if (!closedByEffect) {
            if (!reconnectTimerRef.current) {
              reconnectAttemptRef.current += 1;
              const retryMs = Math.min(15000, 1000 * (2 ** Math.max(0, reconnectAttemptRef.current - 1)));
              reconnectTimerRef.current = window.setTimeout(() => {
                reconnectTimerRef.current = null;
                connect();
              }, retryMs);
            }
          }
        };

        ws.onerror = () => {
          if (wsRef.current !== ws) return;
          setPartyError("Realtime sync degraded. Reconnecting...");
        };
      } catch {
        setPartyError("Realtime sync unavailable. Retrying...");

        if (!reconnectTimerRef.current) {
          reconnectAttemptRef.current += 1;
          const retryMs = Math.min(15000, 1000 * (2 ** Math.max(0, reconnectAttemptRef.current - 1)));
          reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, retryMs);
        }
      }
    }

    connect();

    return () => {
      closedByEffect = true;
      isCleanedUp = true;
      desiredVideoRef.current = null;
      stopHeartbeat();
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (activeSocket) {
        if (activeSocket.readyState === WebSocket.OPEN || activeSocket.readyState === WebSocket.CLOSING) {
          activeSocket.close();
        }
      }
      if (wsRef.current === activeSocket) {
        wsRef.current = null;
      }
    };
  }, [roomId, identity?.token]);

  useEffect(() => {
    if (loading) return;

    let cancelled = false;

    async function mountPlayer() {
      try {
        await ensureYoutubeIframeApi();
        if (cancelled || !playerContainerRef.current) return;
        if (playerRef.current) return;
        if (!window.YT?.Player) return;

        nativeControlsRef.current = true;
        console.log("[YT] creating player, container exists:", !!playerContainerRef.current);
        playerRef.current = new window.YT.Player(playerContainerRef.current, {
          playerVars: {
            autoplay: 0,
            controls: 1,
            disablekb: 0,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (cancelled) return;
              console.log("[YT] onReady fired");

              playerReadyRef.current = true;
              setPlayerReady(true);
              setPlayerIsPlaying(false);
              setPlayerError("");

              const safeVolume = Math.max(0, Math.min(100, Number(playerVolume) || 0));
              if (playerMuted || safeVolume <= 0) {
                playerRef.current?.mute?.();
              } else {
                playerRef.current?.unMute?.();
                playerRef.current?.setVolume?.(safeVolume);
              }

              const firstVideoId = String(currentOpeningRef.current?.youtube_video_id || "").trim();
              const videoIdOnReady = desiredVideoRef.current?.videoId || firstVideoId || "(none)";
              console.log("[YT] onReady about to load videoId:", videoIdOnReady);

              const didFlushDesiredVideo = flushDesiredVideoLoad("ready");
              if (didFlushDesiredVideo) {
                remotePlayerMutationUntilRef.current = Date.now() + 500;
              }

              if (!didFlushDesiredVideo && roomRef.current?.status === "playing" && firstVideoId) {
                remotePlayerMutationUntilRef.current = Date.now() + 500;
                safeLoadVideoById(firstVideoId, 0, { autoplay: false });
              }

              if (lastIncomingPlayerStateRef.current) {
                applyRemotePlayerState(lastIncomingPlayerStateRef.current, false);
              }
            },
            onStateChange: (event) => {
              const ytState = Number(event.data);
              const PLAYING = Number(window.YT?.PlayerState?.PLAYING);
              const PAUSED = Number(window.YT?.PlayerState?.PAUSED);
              const ENDED = Number(window.YT?.PlayerState?.ENDED);
              const CUED = Number(window.YT?.PlayerState?.CUED);

              if (ytState === CUED || ytState === PLAYING || ytState === PAUSED) {
                playerReadyRef.current = true;
                setPlayerReady(true);
              }

              if (ytState === PLAYING) setPlayerIsPlaying(true);
              if (ytState === PAUSED || ytState === ENDED) setPlayerIsPlaying(false);

              if (!isHostRef.current && ytState === PLAYING && !expectedRemotePlaybackRef.current) {
                remotePlayerMutationUntilRef.current = Date.now() + 500;
                playerRef.current?.pauseVideo?.();
                setPlayerIsPlaying(false);
                return;
              }

              if (!isHostRef.current && Date.now() >= remotePlayerMutationUntilRef.current) {
                const shouldPlay = expectedRemotePlaybackRef.current;

                if (shouldPlay && (ytState === PAUSED || ytState === ENDED)) {
                  remotePlayerMutationUntilRef.current = Date.now() + 450;
                  playerRef.current?.playVideo?.();
                }

                if (!shouldPlay && ytState === PLAYING) {
                  remotePlayerMutationUntilRef.current = Date.now() + 450;
                  playerRef.current?.pauseVideo?.();
                }
              }

              if (!isHostRef.current) return;
              if (Date.now() < remotePlayerMutationUntilRef.current) return;

              if (ytState === PLAYING) {
                publishHostPlayerState("host-playing", true);
              }

              if (ytState === PAUSED || ytState === ENDED) {
                publishHostPlayerState("host-paused", false);
              }
            },
            onError: (event) => {
              const code = Number(event?.data || 0);
              const messageByCode = {
                2: "Invalid YouTube video id",
                5: "YouTube player error",
                100: "Video not found or removed",
                101: "Video embedding disabled by owner",
                150: "Video embedding disabled by owner",
              };

              setPlayerError(messageByCode[code] || `YouTube playback error (${code || "unknown"})`);
              setPlayerIsPlaying(false);

              // Keep playerReady intact: player instance is still alive, only the current video failed.
              const desired = desiredVideoRef.current;
              if (desired?.videoId && desired.videoId !== currentVideoIdRef.current) {
                const recovered = safeLoadVideoById(desired.videoId, desired.startSeconds, {
                  autoplay: desired.autoplay,
                  trackDesired: false,
                });
                if (recovered) {
                  remotePlayerMutationUntilRef.current = Date.now() + 500;
                }
              }
            },
          },
        });
      } catch (error) {
        setPlayerError(error.message || "Could not initialize YouTube player");
      }
    }

    mountPlayer();

    return () => {
      cancelled = true;
    };
  }, [loading, room?.status]);

  useEffect(() => {
    if (!playerReady) return;

    const desired = desiredVideoRef.current;
    if (!desired?.videoId) return;
    if (currentVideoIdRef.current === desired.videoId) return;

    safeLoadVideoById(desired.videoId, desired.startSeconds, {
      autoplay: desired.autoplay,
      trackDesired: false,
    });
  }, [playerReady, desiredVideoVersion]);

  useEffect(() => {
    const player = playerRef.current;

    if (room?.status !== "playing") {
      desiredVideoRef.current = null;
      player?.pauseVideo?.();
      setPlayerIsPlaying(false);
      return;
    }

    const nextVideoId = String(currentOpening?.youtube_video_id || "").trim();
    if (!nextVideoId) {
      desiredVideoRef.current = null;
      player?.pauseVideo?.();
      setPlayerIsPlaying(false);
      return;
    }

    if (currentVideoIdRef.current === nextVideoId) {
      return;
    }

    setPlayerError("");
    setPlayerIsPlaying(false);
    remotePlayerMutationUntilRef.current = Date.now() + 500;
    safeLoadVideoById(nextVideoId, 0, { autoplay: false });
  }, [room?.status, currentOpening?.youtube_video_id]);

  useEffect(() => {
    return () => {
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
      currentVideoIdRef.current = "";
      desiredVideoRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!isHost || room?.status !== "playing") return;

    const interval = window.setInterval(() => {
      publishHostDriftSync();
    }, HOST_SYNC_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [isHost, room?.status]);

  useEffect(() => {
    if (isHostRef.current) return;

    const snapshot = lastIncomingPlayerStateRef.current;
    if (!snapshot) return;

    const roomOpeningIndex = Number(room?.current_opening_index);
    const snapshotOpeningIndex = Number(snapshot?.openingIndex);

    if (!Number.isInteger(roomOpeningIndex) || !Number.isInteger(snapshotOpeningIndex)) {
      return;
    }

    if (roomOpeningIndex !== snapshotOpeningIndex) {
      return;
    }

    applyRemotePlayerState(snapshot, false);
  }, [room?.current_opening_index, room?.status, playerReady]);

  useEffect(() => {
    if (!uiNotice) return;

    const timeout = window.setTimeout(() => {
      setUiNotice(null);
    }, 4200);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [uiNotice]);

  function sendPartyEvent(type, payload) {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    socket.send(
      JSON.stringify({
        type,
        payload,
      }),
    );
  }

  function handlePartyEvent(envelope) {
    const type = String(envelope?.type || "");
    const payload = envelope?.payload || {};

    if (!type) return;

    if (type === "presence:update") {
      setHostUuid(String(payload.hostUuid || ""));
      setPartyMembers(Array.isArray(payload.members) ? payload.members : []);

      const connected = Array.isArray(payload.connectedUserUuids)
        ? payload.connectedUserUuids
        : (payload.members || []).filter((member) => member.active).map((member) => member.userUuid);

      setConnectedUserUuids(connected);
      return;
    }

    if (type === "room:state") {
      const roomPatch = payload.room || {};
      const nextStatus = String(roomPatch.status || "");
      const nextIndex = Number(roomPatch.currentOpeningIndex);

      if (nextStatus === "finished") {
        navigate(`/room/${roomId}/rankings`, { replace: true });
        return;
      }

      setRoom((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          status: nextStatus || prev.status,
          current_opening_index: Number.isInteger(nextIndex)
            ? nextIndex
            : prev.current_opening_index,
          host_uuid: String(payload.hostUuid || prev.host_uuid || ""),
        };
      });

      if (payload.hostUuid) {
        setHostUuid(String(payload.hostUuid));
      }

      if (Array.isArray(payload.members)) {
        setPartyMembers(payload.members);
      }

      if (Array.isArray(payload.connectedUserUuids)) {
        setConnectedUserUuids(payload.connectedUserUuids);
      }

      if (payload.playerState) {
        lastIncomingPlayerStateRef.current = payload.playerState;
        applyRemotePlayerState(payload.playerState, false);
      }

      return;
    }

    if (type === "queue:shuffled") {
      setActionLoading(false);
      setShuffleLoading(false);

      if (Array.isArray(payload.openings)) {
        setOpenings(payload.openings);
      }

      const roomPatch = payload.room || {};
      const nextStatus = String(roomPatch.status || "");
      const nextIndex = Number(roomPatch.current_opening_index);

      setRoom((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          status: nextStatus || prev.status,
          current_opening_index: Number.isInteger(nextIndex)
            ? nextIndex
            : prev.current_opening_index,
          host_uuid: String(roomPatch.host_uuid || prev.host_uuid || ""),
        };
      });

      if (roomPatch.host_uuid) {
        setHostUuid(String(roomPatch.host_uuid));
      }

      return;
    }

    if (type === "queue:shuffle:error") {
      setActionLoading(false);
      setShuffleLoading(false);
      showNotice(String(payload.message || "Could not shuffle queue"), "error");
      return;
    }

    if (type === "host:changed") {
      const nextHost = String(payload.hostUuid || "");
      setHostUuid(nextHost);
      setRoom((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          host_uuid: nextHost || prev.host_uuid,
        };
      });
      return;
    }

    if (type === "player:snapshot:request") {
      if (isHostRef.current) {
        publishHostPlayerState("snapshot-request");
      }
      return;
    }

    if (type === "player:state") {
      lastIncomingPlayerStateRef.current = payload;

      if (isHostRef.current && payload.sourceUserUuid === identity?.userId) {
        return;
      }

      applyRemotePlayerState(payload, false);
      return;
    }

    if (type === "player:sync") {
      lastIncomingPlayerStateRef.current = payload;

      if (isHostRef.current && payload.sourceUserUuid === identity?.userId) {
        return;
      }

      applyRemotePlayerState(payload, true);
      return;
    }

    if (type === "rating:submitted") {
      if (!currentOpeningRef.current?.id) return;
      if (String(payload.openingId || "") !== String(currentOpeningRef.current.id)) return;

      const userUuid = String(payload.userUuid || "").trim();
      if (!userUuid) return;

      const rawScore = Number(payload.score);
      const normalizedScore = normalizeRatingValue(rawScore, rawScore);

      if (isInRatingRange(normalizedScore)) {
        setCurrentOpeningVotes((prev) => {
          const previousVote = prev.find((item) => item.user_uuid === userUuid);
          patchUserAverageFromRating(userUuid, normalizedScore, previousVote?.score ?? null);
          return upsertVote(prev, { user_uuid: userUuid, score: normalizedScore });
        });
      }

      // Reconcile with DB to avoid missing decimal updates due transient realtime desync.
      fetchCurrentOpeningVotes();
      return;
    }

    if (type === "opening:skip:confirm-required") {
      if (!isHostRef.current) return;

      const pending = pendingSkipRef.current;
      if (!pending) return;

      const pendingCount = Number(payload.pendingCount || 0);
      openConfirmDialog({
        title: "Skip opening?",
        message: `${pendingCount} users haven't rated yet. Do you want to continue anyway?`,
        confirmLabel: "Skip anyway",
        danger: true,
      }).then((confirmed) => {
        if (!confirmed) {
          setActionLoading(false);
          return;
        }

        sendPartyEvent("opening:next", {
          ...pending,
          force: true,
        });
      });
      return;
    }

    if (type === "opening:next") {
      setActionLoading(false);

      const nextIndex = Number(payload.nextOpeningIndex);
      const nextStatus = String(payload.status || "");
      const graceMs = Number(payload.graceMs || OPENING_GRACE_MS);

      if (nextStatus === "finished") {
        navigate(`/room/${roomId}/rankings`, { replace: true });
        return;
      }

      setRoom((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          status: nextStatus || prev.status,
          current_opening_index: Number.isInteger(nextIndex)
            ? nextIndex
            : prev.current_opening_index,
        };
      });

      setMyRating(0);
      setGraceUntilTs(Date.now() + Math.max(2000, Math.min(3500, graceMs)));
      setPlayerIsPlaying(false);

      const nextVideoId = String(payload.videoId || "").trim();
      if (nextVideoId) {
        desiredVideoRef.current = null;
        setPlayerError("");
        remotePlayerMutationUntilRef.current = Date.now() + 500;
        safeLoadVideoById(nextVideoId, 0, { autoplay: false });
      }

      return;
    }

    if (type === "opening:next:error") {
      setActionLoading(false);
      showNotice(String(payload.message || "Could not advance opening"), "error");
      return;
    }

    if (type === "room:finished") {
      navigate(`/room/${roomId}/rankings`, { replace: true });
    }
  }

  function applyRemotePlayerState(snapshot, driftOnly) {
    const player = playerRef.current;

    const roomOpeningIndex = Number(roomRef.current?.current_opening_index || 0);
    const snapshotOpeningIndex = Number(snapshot?.openingIndex);

    if (Number.isInteger(snapshotOpeningIndex) && snapshotOpeningIndex !== roomOpeningIndex) {
      return;
    }

    const snapshotVideoId = String(snapshot?.videoId || "").trim();
    const expectedVideoId = String(currentOpeningRef.current?.youtube_video_id || "").trim();
    const targetTimestamp = Math.max(0, Number(snapshot?.timestamp || 0));

    if (!isPlayerApiReady(player) || !playerReadyRef.current) {
      if (snapshotVideoId) {
        const shouldPlay = Boolean(snapshot?.isPlaying);
        setPlayerError("");
        expectedRemotePlaybackRef.current = shouldPlay;
        safeLoadVideoById(snapshotVideoId, targetTimestamp, { autoplay: shouldPlay });
      }
      return;
    }

    if (snapshotVideoId && snapshotVideoId !== expectedVideoId) {
      const shouldPlay = Boolean(snapshot?.isPlaying);
      setPlayerError("");
      expectedRemotePlaybackRef.current = shouldPlay;
      remotePlayerMutationUntilRef.current = Date.now() + 600;
      safeLoadVideoById(snapshotVideoId, targetTimestamp, { autoplay: shouldPlay });
      return;
    }

    const currentTimestamp = Number(player.getCurrentTime?.() || 0);
    const driftSeconds = Math.abs(currentTimestamp - targetTimestamp);

    // Small jitter is tolerated; hard seek only when drift becomes noticeable.
    if (driftSeconds > DRIFT_THRESHOLD_SECONDS) {
      remotePlayerMutationUntilRef.current = Date.now() + 500;
      player.seekTo(targetTimestamp, true);
    }

    if (driftOnly) {
      return;
    }

    const PLAYING = Number(window.YT?.PlayerState?.PLAYING);
    const currentState = Number(player.getPlayerState?.());
    const shouldPlay = Boolean(snapshot?.isPlaying);
    expectedRemotePlaybackRef.current = shouldPlay;

    if (shouldPlay && currentState !== PLAYING) {
      ensureRemotePlayback(player, targetTimestamp);
    }

    if (!shouldPlay && currentState === PLAYING) {
      remotePlayerMutationUntilRef.current = Date.now() + 500;
      player.pauseVideo?.();
    }

    setPlayerIsPlaying(shouldPlay);
  }

  function ensureRemotePlayback(player, targetTimestamp = 0) {
    if (!isPlayerApiReady(player)) return;

    const PLAYING = Number(window.YT?.PlayerState?.PLAYING);
    remotePlayerMutationUntilRef.current = Date.now() + 500;
    player.playVideo?.();

    window.setTimeout(() => {
      const nowState = Number(player.getPlayerState?.());
      if (nowState === PLAYING) return;

      // Browser autoplay policies can block remote unmuted playback for non-host clients.
      player.mute?.();
      setPlayerMuted(true);
      remotePlayerMutationUntilRef.current = Date.now() + 500;
      player.playVideo?.();

      const safeTs = Math.max(0, Number(targetTimestamp || 0));
      if (safeTs > 0) {
        player.seekTo?.(safeTs, true);
      }

      showNotice("Autoplay blocked: resumed muted.", "warning");
    }, 320);
  }

  function publishHostPlayerState(reason, isPlayingOverride) {
    if (!isHostRef.current) return;

    const player = playerRef.current;
    if (!isPlayerApiReady(player) || !currentOpeningRef.current) return;

    const currentTime = Number(player.getCurrentTime?.() || 0);
    const ytPlaying = Number(window.YT?.PlayerState?.PLAYING);
    const measuredIsPlaying = Number(player.getPlayerState?.()) === ytPlaying;

    sendPartyEvent("player:state", {
      openingIndex: Number(roomRef.current?.current_opening_index || 0),
      videoId: String(currentOpeningRef.current.youtube_video_id || ""),
      timestamp: Math.max(0, currentTime),
      isPlaying: typeof isPlayingOverride === "boolean" ? isPlayingOverride : measuredIsPlaying,
      reason,
    });

    expectedRemotePlaybackRef.current = typeof isPlayingOverride === "boolean"
      ? isPlayingOverride
      : measuredIsPlaying;
  }

  function publishHostDriftSync() {
    if (!isHostRef.current || roomRef.current?.status !== "playing") return;

    const player = playerRef.current;
    if (!isPlayerApiReady(player) || !playerReadyRef.current || !currentOpeningRef.current) return;

    const ytPlaying = Number(window.YT?.PlayerState?.PLAYING);

    sendPartyEvent("player:sync", {
      openingIndex: Number(roomRef.current?.current_opening_index || 0),
      videoId: String(currentOpeningRef.current.youtube_video_id || ""),
      timestamp: Math.max(0, Number(player.getCurrentTime?.() || 0)),
      isPlaying: Number(player.getPlayerState?.()) === ytPlaying,
      reason: "periodic-sync",
    });

    expectedRemotePlaybackRef.current = Number(player.getPlayerState?.()) === ytPlaying;
  }

  function handleVolumeChange(nextVolume) {
    const safeVolume = Math.max(0, Math.min(100, Number(nextVolume) || 0));
    setPlayerVolume(safeVolume);
    setPlayerMuted(safeVolume <= 0);
  }

  function toggleMute() {
    setPlayerMuted((prev) => !prev);
  }

  function toggleVolumePanel() {
    setVolumePanelOpen((prev) => !prev);
  }

  async function fetchParticipants() {
    const membersResult = await supabase
      .from("room_members")
      .select("room_id,user_uuid,display_name,avatar_url")
      .eq("room_id", roomId);

    if (!membersResult.error && membersResult.data) {
      setParticipants(membersResult.data.map(normalizeParticipantRow));
      return;
    }

    setParticipants([]);
  }

  async function fetchCurrentOpeningVotes() {
    if (!currentOpeningRef.current?.id) {
      setCurrentOpeningVotes([]);
      return;
    }

    const { data, error } = await supabase
      .from("ratings")
      .select("user_uuid,score")
      .eq("room_id", roomId)
      .eq("list_opening_id", currentOpeningRef.current.id);

    if (!error) {
      setCurrentOpeningVotes(data || []);
    }
  }

  async function fetchRoomUserAverages() {
    const { data, error } = await supabase
      .from("ratings")
      .select("user_uuid,score")
      .eq("room_id", roomId);

    if (error) return;

    const aggregates = new Map();
    for (const row of data || []) {
      const userUuid = String(row?.user_uuid || "").trim();
      const score = Number(row?.score || 0);
      if (!userUuid || !Number.isFinite(score)) continue;

      const entry = aggregates.get(userUuid) || { sum: 0, count: 0 };
      entry.sum += score;
      entry.count += 1;
      aggregates.set(userUuid, entry);
    }

    const next = {};
    for (const [userUuid, entry] of aggregates.entries()) {
      if (!entry.count) continue;
      next[userUuid] = {
        avg: entry.sum / entry.count,
        count: entry.count,
      };
    }

    setRoomUserStats(next);
  }

  function patchUserAverageFromRating(userUuid, score, previousOpeningScore = null) {
    setRoomUserStats((prev) => {
      const current = prev[userUuid] || { avg: 0, count: 0 };
      const currentAvg = Number(current.avg);
      const currentCount = Number(current.count);

      let count = Number.isFinite(currentCount) ? currentCount : 0;
      let sum = (Number.isFinite(currentAvg) ? currentAvg : 0) * count;

      if (hasNumericValue(previousOpeningScore)) {
        sum = sum - Number(previousOpeningScore) + Number(score);
      } else {
        count += 1;
        sum += Number(score);
      }

      if (count <= 0) return prev;

      return {
        ...prev,
        [userUuid]: {
          avg: sum / count,
          count,
        },
      };
    });
  }

  async function upsertMyPresence() {
    if (!identity) return;
    await apiPost(`/api/rooms/${roomId}/presence`, {});
  }

  async function handleRate(score) {
    const numericScore = Number(score);
    if (!currentOpening || !identity || room?.status !== "playing" || !isValidRatingValue(numericScore)) return;

    const previous = myRating;
    setMyRating(numericScore);

    try {
      const response = await apiPost("/api/rooms/rate", {
        roomId,
        openingId: currentOpening.id,
        score: numericScore,
      });

      const persistedRawScore = Number(response?.rating?.score);
      const persistedScore = Number.isFinite(persistedRawScore)
        ? persistedRawScore
        : numericScore;

      if (persistedScore !== numericScore) {
        setMyRating(persistedScore);
        showNotice(
          `Score adjusted by server (${formatRatingValue(numericScore)} -> ${formatRatingValue(persistedScore)}).`,
          "warning",
        );
      }

      setCurrentOpeningVotes((prev) => {
        const previousVote = prev.find((item) => item.user_uuid === identity.userId);
        patchUserAverageFromRating(identity.userId, persistedScore, previousVote?.score ?? null);
        return upsertVote(prev, { user_uuid: identity.userId, score: persistedScore });
      });
      fetchRoomUserAverages();
      sendPartyEvent("rating:submitted", {
        openingId: currentOpening.id,
        score: persistedScore,
      });
    } catch (error) {
      setMyRating(previous);
      showNotice(error.message || "Could not submit rating", "error");
      await fetchCurrentOpeningVotes();
    }
  }

  function handleRatingSliderChange(nextValue) {
    const numeric = normalizeRatingValue(nextValue, sliderRating);
    if (!isValidRatingValue(numeric)) return;
    setSliderRating(numeric);
  }

  function commitRatingFromSlider(nextValue = sliderRating) {
    const numeric = normalizeRatingValue(nextValue, sliderRating);
    if (!isValidRatingValue(numeric)) return;
    if (numeric === Number(myRating || 0)) return;
    handleRate(numeric);
  }

  async function handleStartRoom() {
    if (!isHost) return;

    setActionLoading(true);
    try {
      const data = await apiPost("/api/rooms/status", { roomId, status: "playing" });
      setRoom((prev) => ({ ...(prev || {}), ...(data.room || {}) }));
      setGraceUntilTs(Date.now() + OPENING_GRACE_MS);
      setPlayerIsPlaying(false);

      publishHostPlayerState("room-start", false);
    } catch (error) {
      showNotice(error.message || "Could not start room", "error");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleShuffleQueue() {
    if (!isHost || !room || openings.length <= 1) return;

    setActionLoading(true);
    setShuffleLoading(true);

    try {
      // Generate unique idempotency key to prevent duplicate shuffles
      const idempotencyKey = `${identity.userId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // HTTP request to server - returns immediately with result
      const result = await apiPost(`/api/rooms/${roomId}/shuffle`, {
        idempotencyKey,
      });

      if (Array.isArray(result.openings)) {
        setOpenings(result.openings);
      }

      const roomPatch = result.room || {};
      const nextStatus = String(roomPatch.status || "");
      const nextIndex = Number(roomPatch.current_opening_index);

      setRoom((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          status: nextStatus || prev.status,
          current_opening_index: Number.isInteger(nextIndex) ? nextIndex : -1,
          host_uuid: String(roomPatch.host_uuid || prev.host_uuid || ""),
        };
      });

      if (roomPatch.host_uuid) {
        setHostUuid(String(roomPatch.host_uuid));
      }

      // Notify other users with the same canonical order returned by server.
      sendPartyEvent("queue:shuffle:synced", {
        txnId: result.txnId,
        queueVersion: result.queueVersion,
        room: result.room || null,
        openings: Array.isArray(result.openings) ? result.openings : [],
      });

      // Clear loading state as soon as canonical shuffled state is applied
      setActionLoading(false);
      setShuffleLoading(false);
    } catch (error) {
      setActionLoading(false);
      setShuffleLoading(false);
      showNotice(error.message || "Could not shuffle queue", "error");
    }
  }

  function sendOpeningAdvance(targetIndex, finish = false, force = false) {
    const request = {
      targetIndex,
      finish,
      force,
      graceMs: OPENING_GRACE_MS,
    };

    pendingSkipRef.current = request;
    setActionLoading(true);
    sendPartyEvent("opening:next", request);
  }

  async function handleNext() {
    if (!isHost || !room || openings.length === 0) return;

    const isLast = room.current_opening_index >= openings.length - 1;
    const unratedCount = connectedUnratedParticipants.length;

    if (unratedCount > 0) {
      const confirmed = await openConfirmDialog({
        title: "Skip opening?",
        message: `${unratedCount} users haven't rated yet. Do you want to continue anyway?`,
        confirmLabel: "Skip anyway",
        danger: true,
      });
      if (!confirmed) return;
      sendOpeningAdvance(room.current_opening_index + 1, isLast, true);
      return;
    }

    sendOpeningAdvance(room.current_opening_index + 1, isLast, true);
  }

  async function handleSelectOpening(index) {
    if (!isHost || !room) return;

    const safeIndex = Math.max(0, Math.min(openings.length - 1, Number(index)));
    if (!Number.isInteger(safeIndex)) return;
    if (safeIndex === room.current_opening_index) return;

    let force = true;

    if (connectedUnratedParticipants.length > 0) {
      const confirmed = await openConfirmDialog({
        title: "Jump to another opening?",
        message: `${connectedUnratedParticipants.length} users haven't rated yet. Do you want to jump anyway?`,
        confirmLabel: "Jump anyway",
        danger: true,
      });
      if (!confirmed) return;
      force = true;
    }

    sendOpeningAdvance(safeIndex, false, force);
  }

  async function handleDeleteRoom() {
    if (!isHost && room?.owner_user_id !== identity?.userId && identity?.role !== "admin") return;

    const confirmed = await openConfirmDialog({
      title: "Delete room?",
      message: "This action cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;

    try {
      await apiDelete(`/api/rooms/${roomId}`);
      navigate("/");
    } catch (error) {
      showNotice(error.message || "Could not delete room", "error");
    }
  }

  function goPrev() {
    if (!isHost || !room || room.current_opening_index <= 0) return;
    handleSelectOpening(room.current_opening_index - 1);
  }

  function hasVoted(userUuid) {
    return votedUserSet.has(userUuid);
  }

  function showNotice(message, tone = "error") {
    setUiNotice({
      id: Date.now(),
      message: String(message || "Unexpected error"),
      tone,
    });
  }

  function openConfirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
    return new Promise((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmDialog({
        open: true,
        title,
        message,
        confirmLabel,
        danger,
      });
    });
  }

  function closeConfirmDialog(confirmed) {
    if (typeof confirmResolverRef.current === "function") {
      confirmResolverRef.current(Boolean(confirmed));
    }

    confirmResolverRef.current = null;
    setConfirmDialog((prev) => ({ ...prev, open: false }));
  }

  if (loading) {
    return (
      <div
        className="flex items-center justify-center min-h-[100dvh]"
        style={entryTransitionName ? { viewTransitionName: entryTransitionName } : undefined}
      >
        <RefreshCw className="animate-spin text-brand-500" />
      </div>
    );
  }

  return (
    <>
      <div className="room-page-shell">
      <div className="room-page-aurora" aria-hidden="true" />
      <div className="room-page-tide" aria-hidden="true" />
      <div className="room-page-dust" aria-hidden="true" />
      <div className="room-page-gridline" aria-hidden="true" />
      <div className="max-w-[1640px] mx-auto px-3 md:px-4 lg:px-6 py-3 md:py-4 lg:py-5 min-h-[100dvh] flex flex-col gap-3 md:gap-4 relative z-10">
      {uiNotice ? (
        <div
          className={`text-sm px-4 py-3.5 rounded-xl border flex items-start gap-3 animate-fade-in ${
            uiNotice.tone === "warning"
              ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
              : "border-rose-500/40 bg-rose-500/10 text-rose-100"
          }`}
          role="alert"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1">{uiNotice.message}</span>
          <button
            type="button"
            className="p-1 rounded-md hover:bg-black/20 transition-colors"
            onClick={() => setUiNotice(null)}
            aria-label="Close notice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : null}

      <header className="room-glass-header grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] items-start md:items-center shrink-0 gap-3 md:gap-4 room-enter">
        <div
          className="flex items-center gap-4 min-w-0"
          style={entryTransitionName ? { viewTransitionName: entryTransitionName } : undefined}
        >
          <Link to="/" className="p-2 hover:bg-slate-800 rounded-lg transition-colors shrink-0">
            <ChevronLeft className="w-6 h-6" />
          </Link>
          <div className="min-w-0">
            <h1 className="room-title-display truncate">{room?.name}</h1>
            <p className="room-list-meta flex items-center gap-2">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-brand-400/35 bg-brand-500/12 text-brand-200">
                <ListMusic className="w-3 h-3" />
              </span>
              {room?.lists?.name}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <div className="room-stat-chip hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold text-slate-300">
            <Users className="w-3 h-3" />
            {ratedConnectedCount}/{connectedCount} rated
          </div>

          <div className="room-stat-chip hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold text-slate-300">
            <span className={`w-2 h-2 rounded-full ${partyConnected ? "bg-emerald-400" : "bg-slate-500"}`} />
            {partyConnected ? "Realtime" : "Reconnecting"}
          </div>

          {identity?.role === "admin" && (
            <button
              className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
              title="Delete room"
              onClick={handleDeleteRoom}
              aria-label="Delete room"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 md:hidden shrink-0 room-enter" style={{ "--enter-delay": "80ms" }}>
        <div className="room-stat-chip flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-slate-200">
          <Users className="w-3 h-3" />
          {ratedConnectedCount}/{connectedCount} rated
        </div>
        <div className="room-stat-chip flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-slate-300">
          <span className={`w-2 h-2 rounded-full ${partyConnected ? "bg-emerald-400" : "bg-slate-500"}`} />
          {partyConnected ? "Realtime" : "Reconnecting"}
        </div>
      </div>

      {partyError ? (
        <div className="text-sm px-3.5 py-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-100">
          {partyError}
        </div>
      ) : null}

      <div className="room-reimagine-grid flex-1 grid grid-cols-1 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,430px)] gap-4 md:gap-5 xl:gap-6 min-h-0">
        <div className="flex flex-col gap-4 md:gap-6 min-h-0 xl:min-w-0">
          {room?.status === "playing" && currentOpening && (
            <div className="room-radar-panel room-enter flex items-center justify-between px-4 md:px-5 py-2.5" style={{ "--enter-delay": "120ms" }}>
              <div>
                <h3 className="room-anime-now-title">{formatAnimeTitleWithTheme(currentOpening)}</h3>
                <p className="text-[11px] text-slate-400 uppercase tracking-[0.11em]">{currentOpening.opening_label}</p>
              </div>
              <div className="room-jump-chip bg-brand-400/85 px-3 py-1 text-xs font-black shadow-lg text-slate-950 border-0">
                {room?.current_opening_index + 1} / {openings.length}
              </div>
            </div>
          )}

          <div
            className="room-video-stage relative rounded-3xl overflow-hidden shadow-2xl border group h-[clamp(260px,52vh,600px)] room-enter"
            style={{ "--enter-delay": "160ms" }}
            onMouseLeave={() => setVolumePanelOpen(false)}
          >
            {room?.status === "waiting" ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8">
                <div className="w-20 h-20 bg-brand-500/20 rounded-full flex items-center justify-center mb-6 animate-pulse">
                  <Play className="w-10 h-10 text-brand-400 fill-brand-400" />
                </div>
                <h2 className="text-3xl font-black mb-2">Waiting to Start</h2>
                <p className="text-slate-400 max-w-md mb-8">
                  The host will start the session once everyone has joined.
                </p>
                {isHost && (
                  <button
                    className="btn-primary px-12 py-4 text-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={handleStartRoom}
                    disabled={actionLoading}
                  >
                    {actionLoading ? "Starting..." : "START SESSION"}
                  </button>
                )}
              </div>
            ) : room?.status === "finished" ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8">
                <Trophy className="w-20 h-20 text-yellow-500 mb-6" />
                <h2 className="text-3xl font-black mb-2">Session Finished!</h2>
                <p className="text-slate-400 mb-8">All openings have been rated. Check out the final rankings.</p>
                <Link to={`/room/${roomId}/rankings`} className="btn-primary px-12 py-4 text-lg">
                  VIEW RANKINGS
                </Link>
              </div>
            ) : (
              <>
                <div ref={playerContainerRef} className="w-full h-full" />
                {!isHost && room?.status === "playing" && currentOpening?.youtube_video_id ? (
                  <div
                    className="absolute inset-0 z-20"
                    aria-hidden="true"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => event.preventDefault()}
                    onTouchStart={(event) => event.preventDefault()}
                  />
                ) : null}
                {!currentOpening?.youtube_video_id ? (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-center p-8 bg-black/75">
                    <Play className="w-16 h-16 text-slate-600 mb-4" />
                    <h2 className="text-2xl font-black mb-2">Video unavailable</h2>
                    <p className="text-slate-400 max-w-md mb-6">
                      This opening does not have an embeddable YouTube video yet.
                    </p>
                  </div>
                ) : null}
                {tickNow < graceUntilTs && (
                  <div className="absolute top-3 right-3 text-xs font-black uppercase tracking-[0.12em] px-3 py-1 rounded-full bg-slate-900/90 border border-slate-700 text-amber-300">
                    Loading sync...
                  </div>
                )}
                {playerError ? (
                  <div className="absolute bottom-3 left-3 right-3 text-xs px-3 py-2 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-100">
                    {playerError}
                  </div>
                ) : null}
                <div className="absolute inset-0 z-30 pointer-events-none">
                  <div className="absolute right-3 bottom-3 opacity-0 translate-y-3 transition-all duration-200 ease-out group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto">
                    <div className="relative">
                      {!isHost ? (
                        <div className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-slate-700/80 bg-slate-950/90 px-1.5 py-1 shadow-2xl shadow-black/30">
                          <p className="text-[9px] leading-none font-black uppercase tracking-[0.08em] text-amber-300">
                            Host-only playback
                          </p>
                        </div>
                      ) : null}
                      <button
                        type="button"
                        className="p-2.5 rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-lg shadow-[0_14px_40px_rgba(0,0,0,0.38)] transition-all duration-200 ease-out hover:-translate-y-0.5 hover:bg-slate-800/80 hover:shadow-[0_18px_50px_rgba(0,0,0,0.48)] pointer-events-auto"
                        onClick={toggleVolumePanel}
                        aria-label="Open volume control"
                        aria-expanded={volumePanelOpen}
                        title="Open volume control"
                      >
                        {playerMuted || playerVolume <= 0 ? (
                          <VolumeX className="w-4 h-4 text-slate-200" />
                        ) : (
                          <Volume2 className="w-4 h-4 text-slate-200" />
                        )}
                      </button>

                      <div
                        className={`absolute bottom-12 right-0 w-44 rounded-xl border border-slate-700/80 bg-slate-950/95 backdrop-blur p-3 shadow-2xl transition-all duration-200 ease-out ${
                          volumePanelOpen
                            ? "opacity-100 translate-y-0 scale-100 pointer-events-auto"
                            : "opacity-0 translate-y-2 scale-95 pointer-events-none"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs uppercase tracking-[0.12em] text-slate-400">Volume</span>
                          <button
                            type="button"
                            className="text-xs uppercase tracking-[0.12em] text-slate-300 hover:text-white"
                            onClick={toggleMute}
                          >
                            {playerMuted || playerVolume <= 0 ? "Unmute" : "Mute"}
                          </button>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={1}
                          value={playerVolume}
                          onChange={(event) => handleVolumeChange(event.target.value)}
                          className="w-full accent-brand-400"
                          aria-label="Player volume"
                        />
                        <div className="mt-2 text-right text-xs tabular-nums text-slate-300">
                          {playerMuted ? 0 : playerVolume}%
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {room?.status === "playing" && (
            <div className="room-rating-panel card p-4 md:p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 lg:gap-6 room-enter" style={{ "--enter-delay": "220ms" }}>
              <div className="flex-1 text-center md:text-left">
                <div className="max-w-xl mx-auto md:mx-0">
                  <div className="flex items-center justify-center mb-2 text-sm text-slate-400 font-semibold">
                    <span className="text-2xl text-brand-300 tabular-nums font-bold">
                      {myRating > 0 ? (
                        formatRatingValue(myRating)
                      ) : (
                        <span className="room-rating-orb" aria-label="Pending rating" />
                      )}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    step={0.5}
                    value={sliderRating}
                    onChange={(event) => handleRatingSliderChange(event.currentTarget.valueAsNumber)}
                    onMouseUp={(event) => commitRatingFromSlider(event.currentTarget.valueAsNumber)}
                    onTouchEnd={(event) => commitRatingFromSlider(event.currentTarget.valueAsNumber)}
                    onBlur={(event) => commitRatingFromSlider(event.currentTarget.valueAsNumber)}
                    onKeyUp={(event) => {
                      if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
                        commitRatingFromSlider(event.currentTarget.valueAsNumber);
                      }
                    }}
                    className="mx-auto block h-3 w-[calc(90%+12px)] rounded-full bg-slate-700 accent-brand-400 cursor-pointer"
                    aria-label="Rate current opening from 1 to 10 in steps of 0.5"
                  />
                  <div className="mt-2 grid grid-cols-10 text-xs text-slate-500 font-semibold tabular-nums select-none">
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => (
                      <div key={num} className="flex flex-col items-center justify-start gap-1">
                        <span className="block w-0.5 h-2 bg-slate-600 rounded-full" aria-hidden="true" />
                        <span>{num}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {isHost && (
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full lg:w-auto">
                  <button
                    type="button"
                    className="btn-secondary h-11 px-6 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed font-semibold transition-all hover:shadow-lg"
                    onClick={goPrev}
                    disabled={room.current_opening_index <= 0 || actionLoading}
                    aria-label="Go to previous opening"
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    className="btn-primary h-11 px-6 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed font-semibold transition-all hover:shadow-xl hover:-translate-y-0.5"
                    onClick={handleNext}
                    disabled={actionLoading}
                    aria-label={room.current_opening_index >= openings.length - 1 ? "Finish session" : "Go to next opening"}
                  >
                    <SkipForward className="w-4 h-4" />
                    {room.current_opening_index >= openings.length - 1 ? "Finish" : "Next"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4 md:gap-6 min-h-0 xl:min-w-0 xl:w-full xl:max-w-[430px] xl:justify-self-end">
          <div className="room-radar-panel room-enter flex-1 flex flex-col min-h-0 p-0 overflow-hidden" style={{ "--enter-delay": "260ms" }}>
            <div className="flex-1 overflow-y-auto p-5 md:p-6 scrollbar-thin space-y-7">
              <div className="rounded-2xl border border-brand-500/25 bg-brand-500/10 px-4 py-3.5 room-radar-head">
                <p className="text-xs uppercase tracking-[0.12em] text-brand-200/80 font-bold">Score</p>
                <div className="mt-1 flex items-end justify-between gap-3">
                  <p className="text-2xl font-black text-brand-200 tabular-nums">
                    {openingAverage.hasVotes ? openingAverage.value.toFixed(2) : "-"}
                  </p>
                  <p className="text-xs text-brand-100/80 uppercase tracking-[0.12em] font-semibold">
                    {openingAverage.count} rating{openingAverage.count === 1 ? "" : "s"}
                  </p>
                </div>
              </div>

              <div className="space-y-3.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-500 font-bold">Participants</p>
                  {mergedParticipants.length > 5 ? (
                    <button
                      type="button"
                      className="text-xs uppercase tracking-[0.12em] text-slate-400 hover:text-slate-200"
                      onClick={() => setParticipantsExpanded((prev) => !prev)}
                      aria-expanded={participantsExpanded}
                    >
                      {participantsExpanded ? "Show less" : `Show all (${mergedParticipants.length})`}
                    </button>
                  ) : null}
                </div>

                <div
                  className={`space-y-2.5 ${
                    participantsExpanded && mergedParticipants.length > 8
                      ? "max-h-[min(38vh,24rem)] overflow-y-auto scrollbar-thin pr-1"
                      : ""
                  }`}
                >
                  {mergedParticipants
                    .slice(0, participantsExpanded ? mergedParticipants.length : 5)
                    .map((participant) => {
                  const isActive = activeUserSet.has(participant.user_uuid);
                  const voted = hasVoted(participant.user_uuid);
                  const score = userScoreMap[participant.user_uuid];
                  const averageScore = Number(roomUserAverages[participant.user_uuid]);
                  const hasAverageScore = Number.isFinite(averageScore) && averageScore > 0;

                  return (
                    <div
                      key={participant.id}
                      className={`room-radar-entry group relative flex items-center justify-between p-3.5 transition-opacity ${
                        isActive ? "opacity-100" : "opacity-55"
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="relative shrink-0">
                          <img
                            src={participant.avatar_url || getDefaultAvatar(participant.user_name)}
                            alt={participant.user_name}
                            className="w-8 h-8 rounded-full object-cover border border-slate-700"
                            referrerPolicy="no-referrer"
                          />
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 ${
                              isActive
                                ? "bg-emerald-400 border-slate-950"
                                : "bg-transparent border-slate-500"
                            }`}
                            aria-hidden
                          />
                        </div>

                        <div className="min-w-0">
                          <span className="text-sm font-medium block truncate">{participant.user_name}</span>
                          <div className="flex items-center gap-2 mt-1">
                            {participant.user_uuid === hostUuid && (
                              <span className="pill text-xs bg-amber-500/10 text-amber-500 border-amber-500/20">HOST</span>
                            )}
                            {voted ? (
                              <span className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-[0.12em] text-emerald-300 bg-emerald-400/10 border border-emerald-400/20 rounded-full px-2 py-1">
                                <CheckCircle2 className="w-3 h-3" />
                                Rated
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <div className="min-w-[2rem] text-right text-base font-black text-brand-300">
                        {voted ? formatRatingValue(score) : isActive ? "-" : ""}
                      </div>

                      <div className="pointer-events-none absolute right-3 -top-2 z-20 translate-y-1 rounded-lg border border-slate-700/80 bg-slate-950/95 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 opacity-0 shadow-xl transition-all duration-150 group-hover:-translate-y-1 group-hover:opacity-100">
                        Avg: {hasAverageScore ? formatAverageRatingValue(averageScore) : "No ratings yet"}
                      </div>
                    </div>
                  );
                })}
                </div>
              </div>

              <div className="room-soft-divider pt-6 space-y-3.5">
                {isHost && room?.status !== "finished" ? (
                  <div className="room-soft-block rounded-xl px-3.5 py-3">
                    <button
                      type="button"
                      className="w-full flex items-center justify-between gap-3 text-left"
                      onClick={() => setHostToolsExpanded((prev) => !prev)}
                      aria-expanded={hostToolsExpanded}
                    >
                      <span className="text-xs uppercase tracking-[0.12em] text-slate-300 font-bold">Host tools</span>
                      <span className="text-xs uppercase tracking-[0.12em] text-slate-400">
                        {hostToolsExpanded ? "Hide" : "Show"}
                      </span>
                    </button>

                    {hostToolsExpanded ? (
                      <div className="mt-3 flex flex-col gap-2.5">
                        <button
                          type="button"
                          className="inline-flex items-center justify-center gap-2 rounded-full border border-brand-400/30 bg-brand-500/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.12em] text-brand-100 shadow-lg shadow-brand-500/10 transition-all hover:-translate-y-0.5 hover:border-brand-300/50 hover:bg-brand-500/15 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
                          onClick={handleShuffleQueue}
                          disabled={actionLoading || openings.length <= 1}
                          title="Shuffle the queue"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${shuffleLoading ? "animate-spin" : ""}`} />
                          Shuffle
                        </button>
                        <p className="text-sm text-slate-400 leading-relaxed">
                          Pick any opening below to jump the queue.
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-500 font-bold">Queue</p>
                  {openings.length > featuredQueue.length ? (
                    <button
                      type="button"
                      className="text-xs uppercase tracking-[0.12em] text-slate-400 hover:text-slate-200"
                      onClick={() => setQueueExpanded((prev) => !prev)}
                      aria-expanded={queueExpanded}
                    >
                      {queueExpanded ? "Show less" : `Show all (${openings.length})`}
                    </button>
                  ) : null}
                </div>

                <div
                  className={`room-chaos-grid space-y-2.5 pr-1 ${
                    queueExpanded ? "max-h-[min(56vh,34rem)] overflow-y-auto scrollbar-thin" : ""
                  }`}
                >
                  {visibleQueue.map((opening) => {
                    const isCurrent = opening.order_index === room?.current_opening_index;
                    const isPlayable = Boolean(opening.youtube_video_id);

                    return (
                      <button
                        key={opening.id}
                        type="button"
                        onClick={() => isHost && handleSelectOpening(opening.order_index)}
                        disabled={!isHost || actionLoading}
                        className={`room-radar-entry w-full text-left rounded-xl border px-3.5 py-3 transition-all ${
                          isCurrent
                            ? "bg-brand-500/10 border-brand-400/35"
                            : "bg-slate-900/40 border-slate-800 hover:border-slate-700"
                        } ${isHost && !actionLoading ? "hover:-translate-y-0.5" : ""} ${
                          actionLoading ? "opacity-50 cursor-not-allowed" : ""
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center text-xs font-black shrink-0">
                            {opening.order_index + 1}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="room-anime-queue-title truncate flex items-center gap-2">
                              {formatAnimeTitleWithTheme(opening)}
                              {isCurrent && <CheckCircle2 className="w-4 h-4 text-brand-300 shrink-0" />}
                            </p>
                            <p className="text-xs text-slate-500 truncate">{opening.opening_label}</p>
                          </div>
                        </div>
                        {!isPlayable && (
                          <p className="text-xs text-slate-600 mt-2">This item has no embedded YouTube id yet.</p>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </div>

      {confirmDialog.open ? (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl p-6 animate-fade-in">
            <div className="flex items-start gap-3 mb-4">
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                  confirmDialog.danger ? "bg-rose-500/15 text-rose-300" : "bg-amber-500/15 text-amber-300"
                }`}
              >
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-100">{confirmDialog.title}</h3>
                <p className="text-sm text-slate-300 mt-1">{confirmDialog.message}</p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 mt-6">
              <button type="button" className="btn-ghost" onClick={() => closeConfirmDialog(false)}>
                Cancel
              </button>
              <button
                type="button"
                className={confirmDialog.danger ? "btn-secondary btn-danger" : "btn-primary"}
                onClick={() => closeConfirmDialog(true)}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
