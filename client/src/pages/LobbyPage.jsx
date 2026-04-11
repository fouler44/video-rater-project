import { useEffect, useRef, useState } from "react";
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
  User,
  Layout,
  Hash,
  Globe,
  Lock,
  AlertTriangle,
  CheckCircle2,
  X,
  ArrowRight,
  LogIn,
  PartyPopper,
  Sparkles,
  Ticket,
  Music2,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

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

  const quickJoinCardRef = useRef(null);
  const createTriggerResetTimerRef = useRef(null);

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
    <div className="relative mx-auto max-w-7xl px-4 pb-12 pt-24 md:px-6 md:pb-14 md:pt-28">
      <button
        type="button"
        className="fixed right-4 top-4 z-40 inline-flex items-center gap-3 rounded-2xl border border-slate-600/90 bg-slate-900/95 px-3 py-2 text-left shadow-2xl shadow-slate-950/70 backdrop-blur-sm transition hover:-translate-y-0.5 hover:border-brand-300/60 hover:bg-slate-900 md:right-6 md:top-6"
        onClick={() => navigate("/auth")}
      >
        <img
          src={accountAvatarUrl}
          alt="Your avatar"
          className="h-10 w-10 rounded-full border border-slate-700 object-cover"
          referrerPolicy="no-referrer"
        />
        <span className="min-w-0 leading-tight">
          <span className="block text-xs font-bold uppercase tracking-[0.12em] text-brand-200">Account</span>
          <span className="block truncate text-sm font-semibold text-slate-100">
            {signedIn ? "Manage profile" : "Sign in"}
          </span>
        </span>
        {signedIn ? (
          <User className="h-4 w-4 shrink-0 text-brand-300" />
        ) : (
          <LogIn className="h-4 w-4 shrink-0 text-brand-300" />
        )}
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
            className="p-1 rounded-md hover:bg-slate-900/70 transition-colors"
            onClick={() => setUiNotice(null)}
            aria-label="Close notice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : null}

      <section className="relative overflow-hidden rounded-[32px] border border-slate-700/70 bg-slate-900/55 px-6 py-7 md:px-8 md:py-8">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-20 top-12 h-48 w-48 rounded-full bg-brand-500/10 blur-3xl" />
          <div className="absolute right-0 top-0 h-60 w-60 rounded-full bg-amber-400/8 blur-3xl" />
          <div className="absolute inset-x-12 bottom-4 h-px bg-gradient-to-r from-transparent via-slate-500/35 to-transparent" />
        </div>

        <div className="relative grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
          <div className="space-y-5">
            <p className="inline-flex items-center gap-2 rounded-full border border-brand-700/60 bg-brand-950/35 px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-brand-200">
              <PartyPopper className="h-3.5 w-3.5" />
              Opening afterparty
            </p>
            <h1 className="max-w-3xl text-4xl font-black leading-[0.94] text-slate-50 sm:text-5xl md:text-6xl">
              Bring snacks.
              <br />
              We&apos;ll bring the bad takes.
            </h1>
            <p className="max-w-[58ch] text-base leading-relaxed text-slate-300 md:text-lg">
              A night room for dramatic rankings, loud opinions, and the one opening someone will defend like court
              evidence.
            </p>

            <div className="flex flex-wrap items-center gap-2.5">
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
                {showQuickJoin ? "Hide Code Entry" : "Have a Code?"}
              </button>

              {signedIn ? (
                <button className="btn-ghost inline-flex items-center gap-2" onClick={() => navigate("/create-list")}> 
                  <Layout className="h-4 w-4" />
                  Create List
                </button>
              ) : null}
            </div>

            {showQuickJoin ? (
              <div ref={quickJoinCardRef} className="max-w-xl rounded-2xl border border-slate-700/80 bg-slate-950/40 p-4">
                <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Join with invite code</p>
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
                    Join
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="relative">
            <div className="absolute -left-2 top-4 h-24 w-24 rounded-full bg-brand-500/12 blur-2xl" />
            <div className="absolute right-2 top-0 h-20 w-20 rounded-full bg-amber-400/10 blur-2xl" />

            <div className="relative rotate-[-1.5deg] rounded-[30px] border border-brand-700/45 bg-gradient-to-br from-brand-950/45 via-slate-900/70 to-slate-950/60 p-4 shadow-[0_30px_80px_rgba(0,0,0,0.45)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-200/80">Tonight&apos;s vibe</p>
                  <p className="mt-2 text-2xl font-black text-slate-50">Maximum goblin diplomacy.</p>
                </div>
                <div className="rounded-full border border-slate-700 bg-slate-950/50 px-3 py-1 text-xs font-semibold text-slate-300">
                  Bring snacks
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-slate-700/80 bg-slate-950/35 p-4">
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Mood check</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-200">
                    One person is already prepared to say, &quot;No, actually, this opening is genius.&quot;
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-700/80 bg-slate-950/35 p-4">
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Audio warning</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-200">
                    Volume may spike when the first bad opinion lands.
                  </p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-950/35 px-3 py-1.5 text-sm text-slate-200">
                  <Sparkles className="h-4 w-4 text-brand-300" />
                  hot takes loaded
                </span>
                <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-950/35 px-3 py-1.5 text-sm text-slate-200">
                  <Ticket className="h-4 w-4 text-amber-300" />
                  invite codes behaving suspiciously
                </span>
                <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-950/35 px-3 py-1.5 text-sm text-slate-200">
                  <Music2 className="h-4 w-4 text-brand-300" />
                  room noise: politely unhinged
                </span>
              </div>
            </div>

            <div className="absolute -bottom-5 right-6 rotate-[6deg] rounded-2xl border border-slate-700/80 bg-slate-950/85 px-4 py-3 shadow-[0_18px_40px_rgba(0,0,0,0.45)]">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Guest note</p>
              <p className="mt-1 text-sm font-semibold text-slate-100">Mute button sold separately.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-10">
        <div className="rounded-[30px] border border-slate-700/70 bg-slate-900/68 p-6">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-black text-slate-100">Live Rooms ({rooms.length})</h2>
              <button className="btn-ghost inline-flex items-center gap-2 text-sm" onClick={loadPublicRooms} disabled={loading}>
                <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>

            {rooms.length === 0 ? (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-center">
                <p className="text-slate-300">No live rooms right now.</p>
                <div className="mt-4">
                  <button
                    className="btn-primary"
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
                    {signedIn ? "Start a public room" : "Sign in to start a room"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-6">
                {rooms.map((room, idx) => (
                  <button
                    key={room.id}
                    className={`sub-card w-full text-left ${
                      idx % 4 === 0
                        ? "md:col-span-2 lg:col-span-4"
                        : idx % 4 === 1
                          ? "lg:col-span-2"
                          : "lg:col-span-3"
                    }`}
                    onClick={(event) => {
                      const currentIdentity = ensureIdentity();
                      if (!currentIdentity) return;
                      navigateToRoom(room.id, UI_TRANSITIONS.ROOM_ROUTE_STAGE, event.currentTarget);
                    }}
                  >
                    <p className="mb-1 text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Room {String(idx + 1).padStart(2, "0")}</p>
                    <div className="flex items-start justify-between gap-3">
                      <strong className={`line-clamp-2 font-bold text-slate-100 ${idx % 4 === 0 ? "text-lg" : "text-base"}`}>
                        {room.name}
                      </strong>
                      <span className="text-xs font-mono tracking-[0.08em] text-brand-300">{room.invite_code}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-400">{room.lists?.name || "Custom list"}</p>
                  </button>
                ))}
              </div>
            )}
        </div>
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