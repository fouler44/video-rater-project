import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";
import { clearIdentity, getDefaultAvatar, getIdentity, saveIdentity } from "../lib/identity";
import {
  UI_TRANSITIONS,
  markPendingRoomTransition,
  navigateWithTransition,
  runViewTransition,
} from "../lib/viewTransition";
import {
  Plus,
  RefreshCw,
  Layout,
  Hash,
  Globe,
  Lock,
  AlertTriangle,
  CheckCircle2,
  X,
  ArrowRight,
  Radio,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

const LobbyHeroVisual = lazy(() => import("../components/LobbyHeroVisual"));

const ROOM_STAGE_LAYOUT = [
  "lg:col-span-5",
  "lg:col-span-3",
  "lg:col-span-4",
  "lg:col-span-4",
  "lg:col-span-5",
  "lg:col-span-3",
];

export default function LobbyPage() {
  const navigate = useNavigate();
  const [identity, setIdentity] = useState(getIdentity());
  const [lists, setLists] = useState([]);
  const [rooms, setRooms] = useState([]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [selectedList, setSelectedList] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [inviteCode, setInviteCode] = useState("");
  const [showQuickJoin, setShowQuickJoin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uiNotice, setUiNotice] = useState(null);
  const [createTriggerKey, setCreateTriggerKey] = useState("");
  const [createModalOrigin, setCreateModalOrigin] = useState({ x: 0, y: 18 });
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [disableHeavyMotion, setDisableHeavyMotion] = useState(false);

  const quickJoinCardRef = useRef(null);
  const createTriggerResetTimerRef = useRef(null);
  const heroStageRef = useRef(null);
  const trailCanvasRef = useRef(null);
  const trailStateRef = useRef({
    width: 0,
    height: 0,
    dpr: 1,
    cursorX: 0,
    cursorY: 0,
    targetX: 0,
    targetY: 0,
    particles: [],
    frameId: 0,
    lastSpawnAt: 0,
    lastX: 0,
    lastY: 0,
    hasPointer: false,
    lastFrameAt: 0,
    pendingPointerFrameId: 0,
    pendingClientX: 0,
    pendingClientY: 0,
    stageRect: null,
  });

  useEffect(() => {
    loadPublicRooms();
    syncIdentityWithServer();
  }, []);

  useEffect(() => {
    if (!identity?.token) {
      setLists([]);
      return;
    }

    loadLists();
  }, [identity?.token]);

  useEffect(() => {
    if (!uiNotice) return;

    const timeout = window.setTimeout(() => {
      setUiNotice(null);
    }, 3800);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [uiNotice]);

  useEffect(() => {
    return () => {
      if (createTriggerResetTimerRef.current) {
        window.clearTimeout(createTriggerResetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncReducedMotion = () => setPrefersReducedMotion(mediaQuery.matches);
    syncReducedMotion();
    mediaQuery.addEventListener("change", syncReducedMotion);

    return () => {
      mediaQuery.removeEventListener("change", syncReducedMotion);
    };
  }, []);

  useEffect(() => {
    const coarsePointerQuery = window.matchMedia("(pointer: coarse)");

    const syncPerformanceMode = () => {
      const isSmallViewport = window.innerWidth < 1024;
      const cpuCores = navigator.hardwareConcurrency || 8;
      const deviceMemory = navigator.deviceMemory || 8;
      const isConstrainedDevice = cpuCores <= 6 || deviceMemory <= 8;
      setDisableHeavyMotion(coarsePointerQuery.matches || isSmallViewport || isConstrainedDevice);
    };

    syncPerformanceMode();
    coarsePointerQuery.addEventListener("change", syncPerformanceMode);
    window.addEventListener("resize", syncPerformanceMode);

    return () => {
      coarsePointerQuery.removeEventListener("change", syncPerformanceMode);
      window.removeEventListener("resize", syncPerformanceMode);
    };
  }, []);

  useEffect(() => {
    if (prefersReducedMotion || disableHeavyMotion) return;

    const canvas = trailCanvasRef.current;
    const stage = heroStageRef.current;
    if (!canvas || !stage) return undefined;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return undefined;

    const state = trailStateRef.current;
    let resizeObserver = null;

    const resizeCanvas = () => {
      const rect = stage.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

      state.stageRect = rect;
      state.width = rect.width;
      state.height = rect.height;
      state.dpr = dpr;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.imageSmoothingEnabled = false;
    };

    const spawnParticle = (x, y, velocityX, velocityY, energy) => {
      if (state.particles.length >= 56) {
        state.particles.shift();
      }

      state.particles.push({
        x,
        y,
        vx: velocityX,
        vy: velocityY,
        life: 1,
        size: 1.5 + Math.random() * 2.8,
        hue: Math.random() > 0.5 ? "blue" : "amber",
        drift: Math.random() * 0.12 + 0.02,
        energy,
      });
    };

    const draw = () => {
      const now = performance.now();
      if (now - (state.lastFrameAt || 0) < 22) {
        state.frameId = window.requestAnimationFrame(draw);
        return;
      }

      state.lastFrameAt = now;
      const { width, height } = state;
      context.clearRect(0, 0, width, height);

      const cursorDx = state.targetX - state.cursorX;
      const cursorDy = state.targetY - state.cursorY;
      state.cursorX += cursorDx * 0.16;
      state.cursorY += cursorDy * 0.16;

      const moving = Math.abs(cursorDx) + Math.abs(cursorDy) > 0.3;

      if (moving && state.hasPointer && now - state.lastSpawnAt > 52) {
        const speed = Math.min(1.8, Math.hypot(state.targetX - state.lastX, state.targetY - state.lastY) / 12);
        const count = speed > 1.3 ? 1 : 0;

        for (let index = 0; index < count; index += 1) {
          const spread = (Math.random() - 0.5) * 3;
          const lift = (Math.random() - 0.5) * 2.2;
          spawnParticle(
            state.cursorX + spread,
            state.cursorY + lift,
            (Math.random() - 0.5) * 0.42 - cursorDx * 0.016,
            (Math.random() - 0.5) * 0.42 - cursorDy * 0.016,
            speed,
          );
        }

        state.lastSpawnAt = now;
        state.lastX = state.targetX;
        state.lastY = state.targetY;
      }

      for (let index = state.particles.length - 1; index >= 0; index -= 1) {
        const particle = state.particles[index];
        particle.life -= 0.024 + particle.drift * 0.018;
        particle.vx += Math.sin((now + index * 12) * 0.002) * 0.01;
        particle.vy -= 0.005 + particle.drift * 0.006;
        particle.x += particle.vx;
        particle.y += particle.vy;

        const alpha = Math.max(0, particle.life);
        const size = Math.max(1, particle.size * (0.72 + alpha * 0.42));
        const shiftX = Math.sin((now + index * 17) * 0.0018) * 0.9;
        const shiftY = Math.cos((now + index * 13) * 0.0015) * 0.65;

        context.save();
        context.globalAlpha = alpha * 0.32;
        context.shadowBlur = 2;
        context.shadowColor = particle.hue === "blue" ? "rgba(56, 189, 248, 0.2)" : "rgba(251, 146, 60, 0.16)";
        context.fillStyle = particle.hue === "blue" ? "rgba(56, 189, 248, 0.56)" : "rgba(251, 146, 60, 0.5)";
        context.fillRect(
          Math.round(particle.x + shiftX),
          Math.round(particle.y + shiftY),
          size,
          size,
        );

        if (size > 2.5) {
          context.globalAlpha = alpha * 0.08;
          context.fillStyle = "rgba(255, 255, 255, 0.9)";
          context.fillRect(
            Math.round(particle.x + 1 + shiftX),
            Math.round(particle.y + 1 + shiftY),
            Math.max(1, size - 3),
            Math.max(1, size - 3),
          );
        }
        context.restore();

        if (particle.life <= 0 || particle.x < -20 || particle.y < -20 || particle.x > width + 20 || particle.y > height + 20) {
          state.particles.splice(index, 1);
        }
      }

      if (!state.hasPointer && state.particles.length === 0 && Math.abs(cursorDx) + Math.abs(cursorDy) < 0.12) {
        state.frameId = 0;
        return;
      }

      state.frameId = window.requestAnimationFrame(draw);
    };

    const ensureDrawLoop = () => {
      if (state.frameId) return;
      state.frameId = window.requestAnimationFrame(draw);
    };

    const syncPointerFromPending = () => {
      state.pendingPointerFrameId = 0;

      const rect = state.stageRect || stage.getBoundingClientRect();
      state.stageRect = rect;

      const localX = state.pendingClientX - rect.left;
      const localY = state.pendingClientY - rect.top;

      state.targetX = Math.max(0, Math.min(rect.width, localX));
      state.targetY = Math.max(0, Math.min(rect.height, localY));
      state.hasPointer = true;

      const x = (state.targetX / Math.max(rect.width, 1)) * 100;
      const y = (state.targetY / Math.max(rect.height, 1)) * 100;
      const bgX = ((x - 50) / 50) * 5;
      const bgY = ((y - 50) / 50) * 3.5;

      stage.style.setProperty("--bg-x", bgX.toFixed(2));
      stage.style.setProperty("--bg-y", bgY.toFixed(2));
      ensureDrawLoop();
    };

    const handlePointerMove = (event) => {
      state.pendingClientX = event.clientX;
      state.pendingClientY = event.clientY;
      if (state.pendingPointerFrameId) return;
      state.pendingPointerFrameId = window.requestAnimationFrame(syncPointerFromPending);
    };

    const handlePointerLeave = () => {
      state.hasPointer = false;
      state.particles = [];
      stage.style.setProperty("--bg-x", "0");
      stage.style.setProperty("--bg-y", "0");
    };

    const handlePointerEnter = (event) => {
      const rect = stage.getBoundingClientRect();
      state.stageRect = rect;
      state.cursorX = state.targetX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      state.cursorY = state.targetY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
      state.lastX = state.targetX;
      state.lastY = state.targetY;
      state.hasPointer = true;
      ensureDrawLoop();
    };

    resizeCanvas();
    resizeObserver = new ResizeObserver(() => resizeCanvas());
    resizeObserver.observe(stage);
    stage.addEventListener("pointermove", handlePointerMove);
    stage.addEventListener("pointerleave", handlePointerLeave);
    stage.addEventListener("pointerenter", handlePointerEnter);
    state.frameId = window.requestAnimationFrame(draw);

    return () => {
      if (resizeObserver) resizeObserver.disconnect();
      stage.removeEventListener("pointermove", handlePointerMove);
      stage.removeEventListener("pointerleave", handlePointerLeave);
      stage.removeEventListener("pointerenter", handlePointerEnter);
      window.cancelAnimationFrame(state.frameId);
      if (state.pendingPointerFrameId) {
        window.cancelAnimationFrame(state.pendingPointerFrameId);
      }
      state.pendingPointerFrameId = 0;
      state.particles = [];
    };
  }, [prefersReducedMotion, disableHeavyMotion]);

  function armElementTransition(element, transitionName) {
    if (!element || !transitionName) return;

    element.style.viewTransitionName = transitionName;
    window.setTimeout(() => {
      if (element.style.viewTransitionName === transitionName) {
        element.style.viewTransitionName = "";
      }
    }, 900);
  }

  function queueCreateTriggerReset() {
    if (createTriggerResetTimerRef.current) {
      window.clearTimeout(createTriggerResetTimerRef.current);
    }

    createTriggerResetTimerRef.current = window.setTimeout(() => {
      setCreateTriggerKey("");
    }, 520);
  }

  function captureCreateModalOrigin(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect) {
      setCreateModalOrigin({ x: 0, y: 18 });
      return;
    }

    setCreateModalOrigin({
      x: rect.left + rect.width / 2 - window.innerWidth / 2,
      y: rect.top + rect.height / 2 - window.innerHeight / 2,
    });
  }

  function openCreateModal(triggerKey, triggerElement) {
    if (createTriggerResetTimerRef.current) {
      window.clearTimeout(createTriggerResetTimerRef.current);
      createTriggerResetTimerRef.current = null;
    }

    captureCreateModalOrigin(triggerElement);
    setCreateTriggerKey(triggerKey || "");
    armElementTransition(triggerElement, UI_TRANSITIONS.CREATE_ROOM_FLOW);

    runViewTransition(() => {
      setShowCreateModal(true);
    });
  }

  function closeCreateModal() {
    runViewTransition(() => {
      setShowCreateModal(false);
    });
    queueCreateTriggerReset();
  }

  function navigateToRoom(roomId, transitionName, sourceElement) {
    markPendingRoomTransition(transitionName);
    armElementTransition(sourceElement, transitionName);
    navigateWithTransition(navigate, `/room/${roomId}`);
  }

  function navigateToAccount(sourceElement) {
    armElementTransition(sourceElement, "account-route-stage");
    navigateWithTransition(navigate, "/auth");
  }

  async function syncIdentityWithServer() {
    const current = getIdentity();
    if (!current?.token) return;

    try {
      const data = await apiGet("/api/auth/me");
      const merged = saveIdentity({
        token: current.token,
        expiresAt: data.expiresAt || current.expiresAt,
        user: data.user,
      });
      setIdentity(merged);
    } catch {
      clearIdentity();
      setIdentity(null);
    }
  }

  async function loadLists() {
    const current = getIdentity();
    if (!current?.token) {
      setLists([]);
      return;
    }

    try {
      const data = await apiGet("/api/lists");
      const nextLists = data.lists || [];
      setLists(nextLists);
      if (!selectedList && nextLists?.[0]?.id) setSelectedList(nextLists[0].id);
    } catch (error) {
      const message = String(error?.message || "");
      if (message.toLowerCase().includes("unauthorized")) {
        clearIdentity();
        setIdentity(null);
      }
      setLists([]);
    }
  }

  async function loadPublicRooms() {
    setLoading(true);
    try {
      const data = await apiGet("/api/rooms/public");
      setRooms(data.rooms || []);
    } catch {
      setRooms([]);
    } finally {
      setLoading(false);
    }
  }

  function ensureIdentity() {
    const current = getIdentity();
    if (!current?.token || !current?.userId) {
      showNotice("Sign in first to host rooms. You can still join with an invite code.", "warning");
      return null;
    }
    return current;
  }

  async function createRoom() {
    const currentIdentity = ensureIdentity();
    if (!currentIdentity) return;
    if (!newRoomName.trim() || !selectedList) return;

    try {
      const data = await apiPost("/api/rooms", {
        name: newRoomName.trim(),
        listId: selectedList,
        isPublic,
      });

      markPendingRoomTransition(UI_TRANSITIONS.CREATE_ROOM_FLOW);
      navigateWithTransition(navigate, `/room/${data.room.id}`);
    } catch (err) {
      const message = String(err?.message || "");
      if (message.toLowerCase().includes("unauthorized")) {
        showNotice("Your session expired. Sign in again, then create the room.", "error");
        return;
      }
      showNotice("Couldn't create the room. Try a different room name or refresh and try again.", "error");
    }
  }

  async function joinByCode(sourceElement) {
    const currentIdentity = ensureIdentity();
    if (!currentIdentity || !inviteCode.trim()) return;
    try {
      const data = await apiGet(`/api/rooms/by-code/${inviteCode.trim().toUpperCase()}`);
      navigateToRoom(data.room.id, UI_TRANSITIONS.QUICK_JOIN_STAGE, sourceElement || quickJoinCardRef.current);
    } catch {
      showNotice("That invite code doesn't match an active room. Check the code and try again.", "error");
    }
  }

  async function generateSampleList() {
    const currentIdentity = ensureIdentity();
    if (!currentIdentity) return;

    try {
      const generated = await apiGet("/api/lists/preset/top-mal-openings?limit=10");
      const entries = (generated.openings || []).map((opening) => ({
        anime_id: opening.anime_id,
        anime_title: opening.anime_title,
        opening_label: opening.opening_label,
        youtube_video_id: opening.youtube_video_id,
        thumbnail_url: opening.thumbnail_url,
      }));

      const saved = await apiPost("/api/lists/save", {
        name: "Top 10 MAL Openings",
        isPreset: true,
        openings: entries,
      });

      await loadLists();
      setSelectedList(saved.list.id);
      showNotice("Sample list ready. You can create your room now.", "success");
    } catch {
      showNotice("Couldn't create the sample list right now. Try again in a moment.", "error");
    }
  }

  function showNotice(message, tone = "error") {
    setUiNotice({ message: String(message || "Something unexpected happened. Please try again."), tone });
  }

  const signedIn = Boolean(identity?.token && identity?.userId);
  const accountDisplayName = identity?.displayName || "Guest";
  const accountAvatarUrl = identity?.avatarUrl || getDefaultAvatar(accountDisplayName);

  return (
    <div className="lobby-page-shell relative mx-auto max-w-7xl px-4 pb-12 pt-24 md:px-6 md:pb-14 md:pt-28">
      <div className="lobby-water-bg" aria-hidden="true">
        <div className="lobby-water-sheet lobby-water-sheet-a" />
        <div className="lobby-water-sheet lobby-water-sheet-b" />
        <div className="lobby-water-ripple" />
      </div>

      <button
        type="button"
        className="account-portal-chip absolute right-4 top-4 z-40 inline-flex items-center gap-3 rounded-2xl border px-3 py-2 text-left backdrop-blur-sm transition hover:-translate-y-0.5 md:right-6 md:top-6"
        onClick={(event) => navigateToAccount(event.currentTarget)}
      >
        <img
          src={accountAvatarUrl}
          alt="Your avatar"
          className="h-10 w-10 rounded-full border border-slate-700 object-cover"
          referrerPolicy="no-referrer"
        />
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-sm font-semibold text-slate-100">{accountDisplayName}</span>
        </span>
      </button>

      {uiNotice ? (
        <div
          className={`mb-6 max-w-3xl text-sm px-4 py-3 rounded-xl border flex items-start gap-3 animate-fade-in ${
            uiNotice.tone === "success"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"
              : uiNotice.tone === "warning"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
                : "border-rose-500/40 bg-rose-500/10 text-rose-100"
          }`}
          role="alert"
        >
          {uiNotice.tone === "success" ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          )}
          <span className="flex-1">{uiNotice.message}</span>
          <button
            type="button"
            aria-label="Close notice"
            className="p-1 rounded-md hover:bg-slate-900/70 transition-colors"
            onClick={() => setUiNotice(null)}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : null}

      <section
        ref={heroStageRef}
        className="lobby-portal-stage relative overflow-hidden rounded-[38px] border border-slate-700/70 px-6 py-7 md:px-9 md:py-9"
      >
        <div className="pointer-events-none absolute inset-0">
          {!disableHeavyMotion ? <canvas ref={trailCanvasRef} className="lobby-particle-canvas" aria-hidden="true" /> : null}
          <div className="lobby-deep-field" />
          {!disableHeavyMotion ? <div className="lobby-aurora" /> : null}
          {!disableHeavyMotion ? <div className="lobby-noise" /> : null}
        </div>

        <div className="relative grid gap-10 lg:grid-cols-[1fr_1.05fr] lg:items-start">
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
            className="space-y-7"
          >
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-700/75 bg-slate-950/35 px-3 py-1 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-300">
              <Radio className="h-3.5 w-3.5" />
              transmission open
            </div>

            <h1 className="portal-title-stack max-w-3xl text-slate-50">
              <span className="portal-word portal-word-a">VIDEO</span>
              <span className="portal-word portal-word-b">RANK</span>
            </h1>

            <p className="max-w-[40ch] text-sm uppercase tracking-[0.12em] text-slate-400">
              pick a signal / jump in / rank fast
            </p>

            <div className="signal-marquee" aria-hidden="true">
              <div className="signal-marquee-track">
                <span>live rooms</span>
                <span>openings online</span>
                <span>vote pressure</span>
                <span>queue turbulence</span>
                <span>live rooms</span>
                <span>openings online</span>
                <span>vote pressure</span>
                <span>queue turbulence</span>
              </div>
            </div>

            <div className="lobby-command-runway flex flex-wrap gap-2.5">
              <button
                className="btn-primary inline-flex items-center gap-2"
                onClick={(event) => {
                  if (!signedIn) {
                    navigate("/auth");
                    return;
                  }
                  openCreateModal("hero-start-room", event.currentTarget);
                }}
                style={
                  createTriggerKey === "hero-start-room"
                    ? { viewTransitionName: UI_TRANSITIONS.CREATE_ROOM_FLOW }
                    : undefined
                }
              >
                <Plus className="h-4 w-4" />
                {signedIn ? "Start Room" : "Sign in to Start"}
              </button>

              <button
                className="btn-secondary inline-flex items-center gap-2"
                onClick={() => setShowQuickJoin((prev) => !prev)}
                aria-expanded={showQuickJoin}
              >
                <Hash className="h-4 w-4" />
                {showQuickJoin ? "Hide Code" : "Join by Code"}
              </button>

              {signedIn ? (
                <button className="btn-ghost inline-flex items-center gap-2" onClick={() => navigate("/create-list")}> 
                  <Layout className="h-4 w-4" />
                  Create List
                </button>
              ) : null}
            </div>

            {showQuickJoin ? (
              <div
                ref={quickJoinCardRef}
                className="quick-join-inline max-w-xl rounded-2xl border border-slate-700/80 bg-slate-950/45 p-4 backdrop-blur-sm"
              >
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                    placeholder="Enter invite code"
                    className="font-mono uppercase tracking-[0.12em]"
                  />
                  <button
                    className="btn-secondary inline-flex items-center justify-center gap-2 sm:w-auto"
                    onClick={(event) => joinByCode(event.currentTarget)}
                  >
                    Enter
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ) : null}
          </motion.div>

          <Suspense
            fallback={
              <div
                className="hero-tilt-shell portal-sculpt-shell"
                aria-hidden="true"
              />
            }
          >
            <LobbyHeroVisual prefersReducedMotion={prefersReducedMotion} />
          </Suspense>
        </div>
      </section>

      <section className="mt-12">
        <div className="lobby-wall-head mb-5 flex items-center justify-between gap-3">
          <h2 className="text-xl font-black uppercase tracking-[0.08em] text-slate-100">Public Rooms ({rooms.length})</h2>
          <button className="btn-ghost inline-flex items-center gap-2 text-sm" onClick={loadPublicRooms} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {rooms.length === 0 ? (
          <div className="portal-empty-state rounded-3xl border border-slate-800 bg-slate-900/40 p-8 text-center">
            <p className="text-slate-200">No rooms live right now.</p>
            <button
              className="btn-primary mt-5"
              onClick={(event) => {
                if (!signedIn) {
                  navigate("/auth");
                  return;
                }
                openCreateModal("empty-create-room", event.currentTarget);
              }}
              style={
                createTriggerKey === "empty-create-room"
                  ? { viewTransitionName: UI_TRANSITIONS.CREATE_ROOM_FLOW }
                  : undefined
              }
            >
              {signedIn ? "Start Room" : "Sign in to Start"}
            </button>
          </div>
        ) : (
          <div className="portal-room-wall grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-12">
            {rooms.map((room, idx) => {
              const spanClass = ROOM_STAGE_LAYOUT[idx % ROOM_STAGE_LAYOUT.length];

              return (
                <button
                  key={room.id}
                  className={`portal-room-tile room-enter w-full text-left ${spanClass}`}
                  style={{ "--enter-delay": `${Math.min(idx * 48, 320)}ms` }}
                  onClick={(event) => {
                    const currentIdentity = ensureIdentity();
                    if (!currentIdentity) return;
                    navigateToRoom(room.id, UI_TRANSITIONS.ROOM_ROUTE_STAGE, event.currentTarget);
                  }}
                >
                  <div className="portal-room-row">
                    <span className="portal-room-code">{room.invite_code}</span>
                    <span className="portal-room-access">Public</span>
                  </div>

                  <h3 className="mt-4 line-clamp-2 text-xl font-black uppercase leading-tight text-slate-50">{room.name}</h3>

                  <p className="portal-room-copy mt-3 text-sm leading-relaxed text-slate-300/90">
                    Jump in, vote fast, and keep the room moving.
                  </p>

                  <div className="portal-room-foot mt-6 flex items-center justify-between gap-3">
                    <span className="portal-room-enter inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-slate-100">
                      Join room
                      <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                    <span className="portal-room-dot" aria-hidden="true" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Create Room Modal */}
      <AnimatePresence>
        {showCreateModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
              onClick={closeCreateModal}
            />
            <motion.div
              initial={{
                scale: 0.86,
                opacity: 0,
                x: createModalOrigin.x * 0.18,
                y: createModalOrigin.y * 0.18 + 18,
              }}
              animate={{ scale: 1, opacity: 1, x: 0, y: 0 }}
              exit={{ scale: 0.92, opacity: 0, y: 20 }}
              transition={{ type: "spring", damping: 24, stiffness: 320, mass: 0.85 }}
              className="card w-full max-w-md relative z-10 ring-1 ring-brand-500/30"
              style={
                createTriggerKey
                  ? { viewTransitionName: UI_TRANSITIONS.CREATE_ROOM_FLOW }
                  : undefined
              }
            >
              <h3 className="text-2xl font-bold mb-6 text-brand-300">Create Room</h3>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm text-slate-400">Room Name</label>
                  <input
                    value={newRoomName}
                    onChange={(e) => setNewRoomName(e.target.value)}
                    placeholder="e.g. Friday OP Showdown"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm text-slate-400">Opening List</label>
                  <select value={selectedList} onChange={(e) => setSelectedList(e.target.value)}>
                    <option value="">Select a list</option>
                    {lists.map((list) => (
                      <option key={list.id} value={list.id}>{list.name}</option>
                    ))}
                  </select>
                  {lists.length === 0 && (
                    <button 
                      className="text-xs text-brand-400 hover:text-brand-300 underline" 
                      onClick={generateSampleList}
                    >
                      Add a ready-to-play sample list
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-lg">
                  <input
                    type="checkbox"
                    id="is-public"
                    checked={isPublic}
                    onChange={(e) => setIsPublic(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-brand-500 focus:ring-brand-500"
                  />
                  <label htmlFor="is-public" className="text-sm font-medium flex items-center gap-2 cursor-pointer">
                    {isPublic ? <Globe className="w-4 h-4 text-brand-400" /> : <Lock className="w-4 h-4 text-slate-400" />}
                    Show this room in the public lobby
                  </label>
                </div>

                <div className="flex gap-3 pt-4">
                  <button className="btn-ghost flex-1" onClick={closeCreateModal}>Cancel</button>
                  <button 
                    className="btn-primary flex-1" 
                    onClick={createRoom} 
                    disabled={!newRoomName.trim() || !selectedList}
                  >
                    Create Room
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}