import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";
import { clearIdentity, getDefaultAvatar, getIdentity, patchIdentityUser, saveIdentity } from "../lib/identity";
import { Plus, RefreshCw, User, Layout, Hash, Globe, Lock, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export default function LobbyPage() {
  const navigate = useNavigate();
  const [identity, setIdentity] = useState(getIdentity());

  const [displayName, setDisplayName] = useState(identity?.displayName || "");
  const [avatarUrl, setAvatarUrl] = useState(identity?.avatarUrl || "");
  const [lists, setLists] = useState([]);
  const [rooms, setRooms] = useState([]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [selectedList, setSelectedList] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [uiNotice, setUiNotice] = useState(null);

  useEffect(() => {
    loadLists();
    loadPublicRooms();
    syncIdentityWithServer();
  }, []);

  useEffect(() => {
    if (!uiNotice) return;

    const timeout = window.setTimeout(() => {
      setUiNotice(null);
    }, 3800);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [uiNotice]);

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
      setDisplayName(merged?.displayName || "");
      setAvatarUrl(merged?.avatarUrl || "");
    } catch {
      clearIdentity();
      setIdentity(null);
    }
  }

  async function loadLists() {
    try {
      const data = await apiGet("/api/lists");
      const nextLists = data.lists || [];
      setLists(nextLists);
      if (!selectedList && nextLists?.[0]?.id) setSelectedList(nextLists[0].id);
    } catch {
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
      showNotice("Login or register first", "warning");
      return null;
    }
    return current;
  }

  async function saveProfile() {
    const currentIdentity = ensureIdentity();
    if (!currentIdentity) return;

    const trimmed = displayName.trim();
    if (!trimmed) {
      showNotice("Display name is required", "warning");
      return;
    }

    try {
      const data = await apiPost("/api/auth/profile", {
        displayName: trimmed,
        avatarUrl,
      });
      const saved = patchIdentityUser(data.user);
      setIdentity(saved);
      setAvatarUrl(saved?.avatarUrl || "");
      setDisplayName(saved?.displayName || trimmed);
      showNotice("Profile saved", "success");
    } catch (err) {
      showNotice(err.message || "Failed to save profile", "error");
    }
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

      navigate(`/room/${data.room.id}`);
    } catch (err) {
      showNotice(err.message || "Failed to create room", "error");
    }
  }

  async function joinByCode() {
    const currentIdentity = ensureIdentity();
    if (!currentIdentity || !inviteCode.trim()) return;
    try {
      const data = await apiGet(`/api/rooms/by-code/${inviteCode.trim().toUpperCase()}`);
      navigate(`/room/${data.room.id}`);
    } catch {
      showNotice("Invalid room code", "error");
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
    } catch {
      showNotice("Could not generate preset list", "error");
    }
  }

  function showNotice(message, tone = "error") {
    setUiNotice({ message: String(message || "Unexpected error"), tone });
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-12">
      {uiNotice ? (
        <div
          className={`mb-4 text-sm px-4 py-3 rounded-xl border flex items-start gap-3 animate-fade-in ${
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
            className="p-1 rounded-md hover:bg-black/20 transition-colors"
            onClick={() => setUiNotice(null)}
            aria-label="Close notice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : null}

      <header className="mb-12 text-center">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="inline-block mb-4"
        >
          <span className="pill bg-brand-500/10 text-brand-400 border-brand-500/20 px-4 py-1.5 text-sm">
            Anime Opening Rater
          </span>
        </motion.div>
        <h1 className="text-5xl font-extrabold tracking-tight mb-4 bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
          Watch. Rate. Rank.
        </h1>
        <p className="text-slate-400 text-lg max-w-2xl mx-auto">
          Create a room, invite your friends, and decide the best anime opening together in real-time.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column */}
        <div className="lg:col-span-4 space-y-6">
          <section className="card">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2">
                <User className="w-5 h-5 text-brand-400" />
                <h3 className="text-lg font-bold">Account</h3>
              </div>
              <button className="btn-secondary" onClick={() => navigate("/auth")}>
                Login / Register
              </button>
            </div>
            <p className="muted mb-4">Only your visible name and avatar are managed here.</p>

            <div className="flex items-center gap-3 mb-4">
              <img
                src={avatarUrl.trim() || getDefaultAvatar(displayName)}
                alt="Avatar preview"
                className="w-12 h-12 rounded-full object-cover border border-slate-700 bg-slate-900"
                referrerPolicy="no-referrer"
              />
              <div className="text-xs text-slate-500">
                Your avatar appears in the room and chat.
              </div>
            </div>
            <div className="relative">
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Display name"
                className="pl-10"
              />
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            </div>
            <input
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              placeholder="Avatar URL (optional)"
              className="mt-3"
            />
            <button
              className="btn-secondary w-full mt-3"
              onClick={saveProfile}
              disabled={!identity || !displayName.trim()}
            >
              Save profile
            </button>
          </section>

          <section className="card">
            <div className="flex items-center gap-2 mb-4">
              <Plus className="w-5 h-5 text-brand-400" />
              <h3 className="text-lg font-bold">Start Session</h3>
            </div>
            <div className="space-y-3">
              <button 
                className="btn-primary w-full flex items-center justify-center gap-2"
                onClick={() => setShowCreateModal(true)} 
                disabled={!identity}
              >
                <Plus className="w-4 h-4" />
                Create New Room
              </button>
              <button 
                className="btn-secondary w-full flex items-center justify-center gap-2"
                onClick={() => navigate("/create-list")}
                disabled={!identity}
              >
                <Layout className="w-4 h-4" />
                Create Custom List
              </button>
            </div>
          </section>

          <section className="card">
            <div className="flex items-center gap-2 mb-4">
              <Hash className="w-5 h-5 text-brand-400" />
              <h3 className="text-lg font-bold">Join Private Room</h3>
            </div>
            <div className="flex gap-2">
              <input
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                placeholder="Invite code"
                className="font-mono uppercase"
              />
              <button className="btn-secondary" onClick={joinByCode}>Join</button>
            </div>
          </section>
        </div>

        {/* Right Column */}
        <div className="lg:col-span-8">
          <section className="card h-full">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Globe className="w-5 h-5 text-brand-400" />
                <h3 className="text-lg font-bold">Active Public Rooms</h3>
              </div>
              <button 
                className="btn-ghost flex items-center gap-2 text-sm" 
                onClick={loadPublicRooms}
                disabled={loading}
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>

            {rooms.length === 0 ? (
              <div className="empty-state">
                <Globe className="w-12 h-12 text-slate-800 mx-auto mb-4" />
                <p>No public rooms active. Be the first to create one!</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {rooms.map((room) => (
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    key={room.id}
                    className="sub-card text-left hover:border-brand-500/50 transition-colors group"
                    onClick={() => {
                      const currentIdentity = ensureIdentity();
                      if (!currentIdentity) return;
                      navigate(`/room/${room.id}`);
                    }}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <strong className="text-lg group-hover:text-brand-400 transition-colors">{room.name}</strong>
                      <span className="pill text-[10px] py-0.5">Public</span>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-sm text-slate-400">
                        <Hash className="w-3 h-3" />
                        <span>Code: {room.invite_code}</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-slate-400">
                        <Layout className="w-3 h-3" />
                        <span>{room.lists?.name || "Custom list"}</span>
                      </div>
                    </div>
                  </motion.button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Create Room Modal */}
      <AnimatePresence>
        {showCreateModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
              onClick={() => setShowCreateModal(false)}
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="card w-full max-w-md relative z-10"
            >
              <h3 className="text-xl font-bold mb-6">Create New Room</h3>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm text-slate-400">Room Name</label>
                  <input
                    value={newRoomName}
                    onChange={(e) => setNewRoomName(e.target.value)}
                    placeholder="e.g. Anime Night with Friends"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm text-slate-400">Select Opening List</label>
                  <select value={selectedList} onChange={(e) => setSelectedList(e.target.value)}>
                    <option value="">Choose a list...</option>
                    {lists.map((list) => (
                      <option key={list.id} value={list.id}>{list.name}</option>
                    ))}
                  </select>
                  {lists.length === 0 && (
                    <button 
                      className="text-xs text-brand-400 hover:text-brand-300 underline" 
                      onClick={generateSampleList}
                    >
                      Generate Top MAL sample list
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
                    Public room (visible in lobby)
                  </label>
                </div>

                <div className="flex gap-3 pt-4">
                  <button className="btn-ghost flex-1" onClick={() => setShowCreateModal(false)}>Cancel</button>
                  <button 
                    className="btn-primary flex-1" 
                    onClick={createRoom} 
                    disabled={!newRoomName.trim() || !selectedList}
                  >
                    Launch Room
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