import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { getIdentity } from "../lib/identity";
import {
  ArrowLeft,
  Search,
  Trash2,
  Save,
  Layout,
  Music,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  X,
  Link2,
  ListVideo,
  Pencil,
  Plus,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

function sanitizeOpeningLabel(value) {
  if (!value) return "OP1";
  return String(value).replace(/^\d+\s*[:-]\s*/g, "").trim();
}

function extractYoutubeVideoId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;

  try {
    const url = new URL(raw);
    const hostname = String(url.hostname || "").toLowerCase();

    if (hostname.includes("youtu.be")) {
      const fromPath = String(url.pathname || "").replace(/^\//, "").trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(fromPath)) return fromPath;
    }

    const fromV = String(url.searchParams.get("v") || "").trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(fromV)) return fromV;

    const pathParts = String(url.pathname || "").split("/").filter(Boolean);
    const embedIndex = pathParts.findIndex((part) => part === "embed" || part === "shorts");
    if (embedIndex >= 0 && /^[a-zA-Z0-9_-]{11}$/.test(pathParts[embedIndex + 1] || "")) {
      return pathParts[embedIndex + 1];
    }

    return "";
  } catch {
    return "";
  }
}

function mapOpeningWithManualInput(item) {
  const youtubeId = String(item?.youtube_video_id || "").trim();
  return {
    ...item,
    youtube_video_id: youtubeId,
    manual_video_input: youtubeId,
  };
}

export default function CreateListPage() {
  const navigate = useNavigate();
  const identity = getIdentity();

  const [listName, setListName] = useState("");
  const [listItems, setListItems] = useState([]);
  const [saving, setSaving] = useState(false);

  const [myMalLists, setMyMalLists] = useState([]);
  const [myYoutubeLists, setMyYoutubeLists] = useState([]);
  const [editingListId, setEditingListId] = useState("");
  const [editingSource, setEditingSource] = useState("mal");
  const [deletingListId, setDeletingListId] = useState("");

  const [playlistUrl, setPlaylistUrl] = useState("");
  const [playlistListName, setPlaylistListName] = useState("");
  const [isImportingPlaylist, setIsImportingPlaylist] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [addingAnimeId, setAddingAnimeId] = useState("");

  const [uiNotice, setUiNotice] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: "",
    message: "",
    confirmLabel: "Confirm",
    danger: false,
    payloadId: "",
  });

  const canSaveMal = useMemo(
    () => editingSource !== "youtube" && listName.trim().length > 0 && listItems.length > 0,
    [editingSource, listItems.length, listName],
  );

  useEffect(() => {
    if (!identity) {
      navigate("/");
      return;
    }

    loadMyLists();
  }, []);

  useEffect(() => {
    if (!uiNotice) return;

    const timeout = window.setTimeout(() => {
      setUiNotice(null);
    }, 4200);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [uiNotice]);

  function resetEditor() {
    setEditingListId("");
    setEditingSource("mal");
    setListName("");
    setListItems([]);
    setSearchQuery("");
    setSearchResults([]);
  }

  async function loadMyLists() {
    if (!identity) return;

    try {
      const data = await apiGet("/api/lists");
      const isAdmin = String(identity.role || "") === "admin";
      const visible = (data.lists || []).filter((list) => {
        if (isAdmin) return true;
        if (list.is_preset) return false;
        return list.created_by === identity.userId;
      });

      const malLists = visible.filter((list) => (list.list_source || "mal") !== "youtube");
      const youtubeLists = visible.filter((list) => list.list_source === "youtube");

      setMyMalLists(malLists);
      setMyYoutubeLists(youtubeLists);
    } catch {
      setMyMalLists([]);
      setMyYoutubeLists([]);
    }
  }

  async function importYoutubePlaylistList() {
    if (!identity || !playlistUrl.trim()) return;

    setIsImportingPlaylist(true);
    try {
      const saved = await apiPost("/api/lists/import-youtube-playlist", {
        playlistUrl: playlistUrl.trim(),
        listName: playlistListName.trim() || undefined,
      });

      setPlaylistUrl("");
      setPlaylistListName("");
      await loadMyLists();
      await startViewYoutubeList(saved.list.id);
      showNotice(`Playlist loaded with ${saved.list.count} videos.`, "success");
    } catch (error) {
      showNotice(error.message || "Could not load YouTube playlist", "error");
    } finally {
      setIsImportingPlaylist(false);
    }
  }

  async function searchAnimeForMalList() {
    if (editingSource === "youtube") {
      showNotice("Select a MAL list to add anime entries.", "error");
      return;
    }

    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const data = await apiGet(`/api/jikan/search-anime?q=${encodeURIComponent(searchQuery)}&limit=10`);
      setSearchResults(data.data || []);
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }

  async function addAnimeToMalList(anime) {
    if (editingSource === "youtube") {
      showNotice("You cannot add anime to a YouTube list.", "error");
      return;
    }

    const animeId = String(anime?.mal_id || "").trim();
    if (!animeId) return;

    setAddingAnimeId(animeId);

    try {
      let openingLabels = ["OP1"];
      try {
        const data = await apiGet(`/api/jikan/anime/${animeId}/themes`);
        const fromThemes = (data?.data?.openings || [])
          .map((label) => sanitizeOpeningLabel(label))
          .filter(Boolean);
        if (fromThemes.length > 0) {
          openingLabels = [...new Set(fromThemes)];
        }
      } catch {
        openingLabels = ["OP1"];
      }

      const animeTitle = anime.title_english || anime.title || `MAL ${animeId}`;
      const thumb = anime.images?.jpg?.image_url || anime.images?.jpg?.large_image_url || "";

      const existingKeys = new Set(
        listItems.map((item) => `${item.anime_id}::${String(item.opening_label || "").trim().toLowerCase()}`),
      );

      const rowsToAdd = openingLabels
        .map((label) => ({
          anime_id: Number(animeId),
          anime_title: animeTitle,
          opening_label: label,
          youtube_video_id: "",
          manual_video_input: "",
          thumbnail_url: thumb,
        }))
        .filter((row) => !existingKeys.has(`${row.anime_id}::${String(row.opening_label || "").trim().toLowerCase()}`));

      if (rowsToAdd.length === 0) {
        showNotice("That anime (openings) is already in the list.", "error");
        return;
      }

      setListItems((prev) => [...prev, ...rowsToAdd]);
      showNotice(`${rowsToAdd.length} opening(s) added without YouTube link.`, "success");
    } finally {
      setAddingAnimeId("");
    }
  }

  async function startEditMalList(listId) {
    if (!listId || !identity) {
      resetEditor();
      return;
    }

    setEditingListId(listId);
    setEditingSource("mal");
    const selected = myMalLists.find((item) => item.id === listId);
    setListName(selected?.name || "");

    try {
      const data = await apiGet(`/api/lists/${listId}/openings`);
      setListItems((data.openings || []).map(mapOpeningWithManualInput));
    } catch (error) {
      showNotice(error.message || "Could not load list", "error");
    }
  }

  async function startViewYoutubeList(listId) {
    if (!listId || !identity) {
      resetEditor();
      return;
    }

    setEditingListId(listId);
    setEditingSource("youtube");
    const selected = myYoutubeLists.find((item) => item.id === listId);
    setListName(selected?.name || "");

    try {
      const data = await apiGet(`/api/lists/${listId}/openings`);
      setListItems((data.openings || []).map(mapOpeningWithManualInput));
      setSearchQuery("");
      setSearchResults([]);
    } catch (error) {
      showNotice(error.message || "Could not load list", "error");
    }
  }

  async function handleDeleteList(listId) {
    if (!identity || !listId) return;

    const list = [...myMalLists, ...myYoutubeLists].find((item) => item.id === listId);
    setConfirmDialog({
      open: true,
      title: "Delete list?",
      message: `Delete list "${list?.name || "Custom list"}"? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
      payloadId: listId,
    });
  }

  async function confirmDeleteList() {
    const listId = confirmDialog.payloadId;
    if (!identity || !listId) {
      setConfirmDialog((prev) => ({ ...prev, open: false, payloadId: "" }));
      return;
    }

    setDeletingListId(listId);
    setConfirmDialog((prev) => ({ ...prev, open: false }));
    try {
      await apiDelete(`/api/lists/${listId}`);

      if (editingListId === listId) {
        resetEditor();
      }

      await loadMyLists();
    } catch (error) {
      showNotice(error.message || "Could not delete list. If it is used by a room, delete/finish that room first.", "error");
    } finally {
      setDeletingListId("");
      setConfirmDialog((prev) => ({ ...prev, payloadId: "" }));
    }
  }

  function applyManualVideoLink(index) {
    if (editingSource === "youtube") return;

    const item = listItems[index];
    if (!item) return;

    const normalizedId = extractYoutubeVideoId(item.manual_video_input || "");
    if (!normalizedId) {
      showNotice("Invalid YouTube link or video ID", "error");
      return;
    }

    setListItems((prev) =>
      prev.map((entry, i) => {
        if (i !== index) return entry;
        return {
          ...entry,
          youtube_video_id: normalizedId,
          manual_video_input: normalizedId,
          thumbnail_url: entry.thumbnail_url || `https://i.ytimg.com/vi/${normalizedId}/mqdefault.jpg`,
        };
      }),
    );

    showNotice("YouTube link updated", "success");
  }

  async function handleSaveMalList() {
    if (!identity || !canSaveMal) return;

    setSaving(true);
    try {
      const payload = listItems.map((item) => ({
        anime_id: item.anime_id,
        anime_title: item.anime_title,
        opening_label: item.opening_label,
        youtube_video_id: item.youtube_video_id,
        thumbnail_url: item.thumbnail_url,
      }));

      await apiPost("/api/lists/save", {
        listId: editingListId || undefined,
        name: listName.trim(),
        isPreset: false,
        source: "mal",
        openings: payload,
      });

      await loadMyLists();
      showNotice("MAL list saved.", "success");
    } catch (error) {
      showNotice(error.message || "Could not save list", "error");
    } finally {
      setSaving(false);
    }
  }

  function showNotice(message, tone = "error") {
    setUiNotice({
      message: String(message || "Unexpected error"),
      tone,
    });
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-12">
      {uiNotice ? (
        <div
          className={`mb-4 text-sm px-4 py-3 rounded-xl border flex items-start gap-3 animate-fade-in ${
            uiNotice.tone === "success"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"
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

      <header className="flex flex-wrap items-center justify-between gap-6 mb-12">
        <div className="flex items-center gap-4">
          <button
            className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
            onClick={() => navigate("/")}
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div>
            <h1 className="text-3xl font-bold">Create Custom List</h1>
            <p className="text-slate-400">Load playlists and edit lists from one panel.</p>
          </div>
        </div>
        <button
          className="btn-primary flex items-center gap-2"
          onClick={handleSaveMalList}
          disabled={!canSaveMal || saving}
          title={editingSource === "youtube" ? "YouTube lists are read-only here" : "Save MAL list"}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {editingSource === "youtube"
            ? "Read-only"
            : editingListId
              ? "Update MAL List"
              : "Save MAL List"}
        </button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-5 space-y-8">
          <section className="card">
            <div className="flex items-center gap-2 mb-6">
              <ListVideo className="w-5 h-5 text-brand-400" />
              <h3 className="text-lg font-bold">Load YouTube Playlist</h3>
              <span className="pill text-[10px]">Create YouTube list</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div className="space-y-2">
                <label className="text-xs text-slate-500 uppercase font-bold tracking-wider">Playlist URL</label>
                <input
                  value={playlistUrl}
                  onChange={(e) => setPlaylistUrl(e.target.value)}
                  placeholder="https://www.youtube.com/playlist?list=..."
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs text-slate-500 uppercase font-bold tracking-wider">List Name (optional)</label>
                <input
                  value={playlistListName}
                  onChange={(e) => setPlaylistListName(e.target.value)}
                  placeholder="Use playlist title if empty"
                />
              </div>
            </div>

            <button
              className="btn-secondary w-full flex items-center justify-center gap-2"
              onClick={importYoutubePlaylistList}
              disabled={isImportingPlaylist || !playlistUrl.trim()}
            >
              {isImportingPlaylist ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
              Load Playlist
            </button>
          </section>

          <section className="card">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
              <Pencil className="w-5 h-5 text-brand-400" />
              MAL Lists
            </h3>
            <div className="space-y-2 max-h-[260px] overflow-y-auto pr-2 scrollbar-thin mb-6">
              {myMalLists.length === 0 ? (
                <p className="text-sm text-slate-500 italic">No MAL lists yet.</p>
              ) : (
                myMalLists.map((list) => (
                  <div key={list.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-900/50 border border-slate-800 hover:border-slate-700 transition-all group">
                    <span className="text-sm font-medium truncate flex-1 mr-2">{list.name}</span>
                    <div className="flex items-center gap-1">
                      <button
                        className={`p-2 rounded-lg transition-colors ${editingListId === list.id ? "bg-brand-500 text-white" : "text-slate-400 hover:bg-slate-800"}`}
                        onClick={() => startEditMalList(list.id)}
                        title="Edit list"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
                        onClick={() => handleDeleteList(list.id)}
                        disabled={deletingListId === list.id}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
              <ListVideo className="w-5 h-5 text-brand-400" />
              YouTube Lists (Your playlists)
            </h3>
            <div className="space-y-2 max-h-[260px] overflow-y-auto pr-2 scrollbar-thin">
              {myYoutubeLists.length === 0 ? (
                <p className="text-sm text-slate-500 italic">No YouTube lists yet.</p>
              ) : (
                myYoutubeLists.map((list) => (
                  <div key={list.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-900/50 border border-slate-800 hover:border-slate-700 transition-all group">
                    <span className="text-sm font-medium truncate flex-1 mr-2">{list.name}</span>
                    <div className="flex items-center gap-1">
                      <button
                        className={`p-2 rounded-lg transition-colors ${editingListId === list.id ? "bg-brand-500 text-white" : "text-slate-400 hover:bg-slate-800"}`}
                        onClick={() => startViewYoutubeList(list.id)}
                        title="Edit list"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
                        onClick={() => handleDeleteList(list.id)}
                        disabled={deletingListId === list.id}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <div className="lg:col-span-7 space-y-8">
          {editingListId ? (
            <>
              {editingSource !== "youtube" ? (
                <section className="card">
                  <div className="flex items-center gap-2 mb-6">
                    <Plus className="w-5 h-5 text-brand-400" />
                    <h3 className="text-lg font-bold">Add Anime To MAL List</h3>
                  </div>

                  <div className="relative mb-6">
                    <input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && searchAnimeForMalList()}
                      placeholder="Search anime title (Jikan)"
                      className="pl-12 h-12"
                    />
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
                    <button
                      className="absolute right-2 top-1/2 -translate-y-1/2 btn-primary !py-1.5 !px-4 text-sm"
                      onClick={searchAnimeForMalList}
                      disabled={isSearching}
                    >
                      {isSearching ? "..." : "Search"}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[420px] overflow-y-auto pr-2 scrollbar-thin">
                    {searchResults.map((anime) => {
                      const animeId = String(anime.mal_id || "");
                      const isAdding = addingAnimeId === animeId;

                      return (
                        <div
                          key={animeId}
                          className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/30 border border-slate-800"
                        >
                          <img
                            src={anime.images?.jpg?.small_image_url || ""}
                            alt=""
                            className="w-12 h-12 rounded-lg object-cover"
                            referrerPolicy="no-referrer"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold truncate">{anime.title_english || anime.title}</p>
                            <p className="text-[10px] text-slate-500 uppercase">{anime.type || "TV"}</p>
                          </div>
                          <button
                            className="btn-secondary !px-3 !py-2 text-xs"
                            onClick={() => addAnimeToMalList(anime)}
                            disabled={isAdding}
                          >
                            {isAdding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Add"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              <section className="card flex flex-col h-[700px]">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-lg font-bold flex items-center gap-2">
                    <Layout className="w-5 h-5 text-brand-400" />
                    List Preview
                  </h3>
                  <span className="pill text-[10px]">{listItems.length} items</span>
                </div>

                <div className="mb-4">
                  <input
                    value={listName}
                    onChange={(e) => setListName(e.target.value)}
                    placeholder="Name your list..."
                    disabled={editingSource === "youtube"}
                    className="font-bold text-lg border-none bg-slate-800/50 focus:ring-0"
                  />
                </div>

                <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin">
                  {listItems.length === 0 ? (
                    <div className="empty-state h-full flex flex-col items-center justify-center">
                      <Music className="w-12 h-12 text-slate-800 mb-4" />
                      <p className="text-sm">This list is empty.</p>
                      <p className="text-xs text-slate-600 mt-1">Add anime to a MAL list or load a YouTube playlist.</p>
                    </div>
                  ) : (
                    listItems.map((item, idx) => (
                      <motion.div
                        layout
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        key={`${item.anime_id}-${idx}`}
                        className="rounded-xl bg-slate-800/30 border border-slate-800 group p-3"
                      >
                        <div className="flex items-center gap-3">
                          <div className="relative w-12 h-12 flex-shrink-0">
                            <img
                              src={item.thumbnail_url || ""}
                              alt=""
                              className="w-full h-full object-cover rounded-lg"
                              referrerPolicy="no-referrer"
                            />
                            <div className="absolute -top-1 -left-1 w-5 h-5 bg-slate-900 border border-slate-700 rounded-full flex items-center justify-center text-[10px] font-bold">
                              {idx + 1}
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold truncate">{item.anime_title}</p>
                            <p className="text-[10px] text-slate-500 truncate">{item.opening_label}</p>
                          </div>
                          <button
                            className="p-2 text-slate-600 hover:text-red-400 transition-colors"
                            onClick={() => setListItems((prev) => prev.filter((_, i) => i !== idx))}
                            disabled={editingSource === "youtube"}
                            title={editingSource === "youtube" ? "Read-only" : "Remove"}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>

                        {editingSource !== "youtube" ? (
                          <div className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
                            <input
                              value={item.manual_video_input || ""}
                              onChange={(e) => {
                                const value = e.target.value;
                                setListItems((prev) =>
                                  prev.map((entry, i) => (i === idx ? { ...entry, manual_video_input: value } : entry)),
                                );
                              }}
                              placeholder="Paste YouTube link or video ID later"
                              className="text-xs"
                            />
                            <button
                              className="btn-secondary !px-3 !py-2 text-xs"
                              onClick={() => applyManualVideoLink(idx)}
                            >
                              Apply Link
                            </button>
                          </div>
                        ) : (
                          <p className="mt-2 text-[11px] text-slate-500">Video ID: {item.youtube_video_id || "none"}</p>
                        )}
                      </motion.div>
                    ))
                  )}
                </div>
              </section>
            </>
          ) : (
            <section className="card h-full min-h-[420px] flex items-center justify-center">
              <div className="text-center">
                <Layout className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                <p className="text-slate-300 font-medium">Select a list to edit</p>
                <p className="text-slate-500 text-sm mt-1">Use the edit button in MAL or YouTube lists.</p>
              </div>
            </section>
          )}
        </div>
      </div>

      <AnimatePresence>
        {confirmDialog.open ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl p-6"
            >
              <div className="flex items-start gap-3 mb-4">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-rose-500/15 text-rose-300">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-slate-100">{confirmDialog.title}</h3>
                  <p className="text-sm text-slate-300 mt-1">{confirmDialog.message}</p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 mt-6">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setConfirmDialog((prev) => ({ ...prev, open: false, payloadId: "" }))}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-danger"
                  onClick={confirmDeleteList}
                >
                  {confirmDialog.confirmLabel}
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
