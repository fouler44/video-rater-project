import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../lib/api";
import { getIdentity } from "../lib/identity";
import { supabase } from "../lib/supabase";
import { 
  ArrowLeft, 
  Plus, 
  Search, 
  Trash2, 
  Save, 
  Zap, 
  Layout, 
  ChevronRight, 
  Music, 
  Play, 
  CheckCircle2,
  Loader2
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

const YOUTUBE_POPULAR_LIST_MAX = 50;

function sanitizeOpeningLabel(value) {
  if (!value) return "OP1";
  return String(value).replace(/^\d+\s*[:-]\s*/g, "").trim();
}

export default function CreateListPage() {
  const navigate = useNavigate();
  const identity = getIdentity();

  const [listName, setListName] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedAnime, setSelectedAnime] = useState(null);
  const [animeOpenings, setAnimeOpenings] = useState([]);
  const [ytResults, setYtResults] = useState([]);
  const [isYtSearching, setIsYtSearching] = useState(false);
  const [currentOpeningToAttach, setCurrentOpeningToAttach] = useState("");
  const [listItems, setListItems] = useState([]);
  const [saving, setSaving] = useState(false);

  const [myCustomLists, setMyCustomLists] = useState([]);
  const [editingListId, setEditingListId] = useState("");
  const [deletingListId, setDeletingListId] = useState("");

  const [quickListName, setQuickListName] = useState("");
  const [quickCount, setQuickCount] = useState(25);
  const [isGeneratingQuickList, setIsGeneratingQuickList] = useState(false);

  const canSave = useMemo(
    () => listName.trim().length > 0 && listItems.length > 0,
    [listName, listItems],
  );

  useEffect(() => {
    if (!identity) {
      navigate("/");
      return;
    }

    loadMyLists();
  }, []);

  function resetEditor() {
    setEditingListId("");
    setListName("");
    setListItems([]);
    setSearchQuery("");
    setSearchResults([]);
    setSelectedAnime(null);
    setAnimeOpenings([]);
    setYtResults([]);
    setCurrentOpeningToAttach("");
  }

  async function loadMyLists() {
    if (!identity) return;

    const { data, error } = await supabase
      .from("lists")
      .select("id,name")
      .eq("created_by", identity.uuid)
      .eq("is_preset", false)
      .order("created_at", { ascending: false });

    if (!error) setMyCustomLists(data || []);
  }

  async function generatePopularListQuickly() {
    if (!identity) return;

    const count = Math.max(1, Math.min(YOUTUBE_POPULAR_LIST_MAX, Number(quickCount) || 25));
    setIsGeneratingQuickList(true);

    try {
      const generated = await apiGet(`/api/lists/preset/top-mal-openings?source=popular&limit=${count}`);
      const finalName = quickListName.trim() || `Popular Top ${count} Openings`;

      const { data: list, error: listError } = await supabase
        .from("lists")
        .insert({
          name: finalName,
          created_by: identity.uuid,
          is_preset: false,
        })
        .select("id,name")
        .single();

      if (listError) throw listError;

      const entries = (generated.openings || []).map((opening, index) => ({
        ...opening,
        list_id: list.id,
        order_index: index,
      }));

      if (entries.length > 0) {
        const { error: openingError } = await supabase.from("list_openings").insert(entries);
        if (openingError) throw openingError;
      }

      setQuickListName("");
      await loadMyLists();
      await startEditList(list.id);
      alert(`List created with ${entries.length} openings.`);
    } catch (error) {
      alert(error.message || "Could not generate quick list");
    } finally {
      setIsGeneratingQuickList(false);
    }
  }

  async function searchAnime() {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const data = await apiGet(`/api/jikan/search-anime?q=${encodeURIComponent(searchQuery)}&limit=8`);
      setSearchResults(data.data || []);
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }

  async function selectAnime(anime) {
    setSelectedAnime(anime);
    setSearchResults([]);
    setYtResults([]);
    setCurrentOpeningToAttach("");

    try {
      const data = await apiGet(`/api/jikan/anime/${anime.mal_id}/themes`);
      const openings = (data?.data?.openings || []).map((op) => sanitizeOpeningLabel(op)).filter(Boolean);
      setAnimeOpenings(openings.length > 0 ? openings : ["OP1"]);
    } catch {
      setAnimeOpenings(["OP1"]);
    }
  }

  async function searchYouTube(opening) {
    if (!selectedAnime) return;
    setCurrentOpeningToAttach(opening);
    setIsYtSearching(true);
    try {
      const query = `${selectedAnime.title} ${opening} opening official crunchyroll tv size 1:30`;
      const data = await apiGet(`/api/youtube/search?q=${encodeURIComponent(query)}`);
      setYtResults(data.items || []);
    } catch {
      setYtResults([]);
    } finally {
      setIsYtSearching(false);
    }
  }

  function addToList(video) {
    if (!selectedAnime || !currentOpeningToAttach) return;

    const newItem = {
      anime_id: selectedAnime.mal_id,
      anime_title: selectedAnime.title_english || selectedAnime.title,
      opening_label: currentOpeningToAttach,
      youtube_video_id: video.id.videoId,
      thumbnail_url:
        video.snippet.thumbnails?.medium?.url ||
        selectedAnime.images?.jpg?.image_url ||
        "",
      channel_title: video.snippet.channelTitle || "",
      duration_text: video.durationText || "",
    };

    setListItems((prev) => [...prev, newItem]);
    setYtResults([]);
    setCurrentOpeningToAttach("");
    setSelectedAnime(null);
    setAnimeOpenings([]);
    setSearchQuery("");
  }

  async function startEditList(listId) {
    if (!listId || !identity) {
      resetEditor();
      return;
    }

    setEditingListId(listId);
    const selected = myCustomLists.find((item) => item.id === listId);
    setListName(selected?.name || "");

    const { data, error } = await supabase
      .from("list_openings")
      .select("anime_id,anime_title,opening_label,youtube_video_id,thumbnail_url,order_index")
      .eq("list_id", listId)
      .order("order_index", { ascending: true });

    if (error) {
      alert(error.message);
      return;
    }

    setListItems(data || []);
  }

  async function handleDeleteList(listId) {
    if (!identity || !listId) return;

    const list = myCustomLists.find((item) => item.id === listId);
    const confirmDelete = window.confirm(
      `Delete list "${list?.name || "Custom list"}"? This cannot be undone.`,
    );

    if (!confirmDelete) return;

    setDeletingListId(listId);
    try {
      const { error } = await supabase
        .from("lists")
        .delete()
        .eq("id", listId)
        .eq("created_by", identity.uuid)
        .eq("is_preset", false);

      if (error) throw error;

      if (editingListId === listId) {
        resetEditor();
      }

      await loadMyLists();
    } catch (error) {
      alert(error.message || "Could not delete list. If it is used by a room, delete/finish that room first.");
    } finally {
      setDeletingListId("");
    }
  }

  async function handleSaveList() {
    if (!identity || !canSave) return;

    setSaving(true);
    try {
      let listId = editingListId;

      if (!editingListId) {
        const { data: created, error: createError } = await supabase
          .from("lists")
          .insert({
            name: listName.trim(),
            created_by: identity.uuid,
            is_preset: false,
          })
          .select("id")
          .single();

        if (createError) throw createError;
        listId = created.id;
      } else {
        const { error: renameError } = await supabase
          .from("lists")
          .update({ name: listName.trim() })
          .eq("id", editingListId)
          .eq("created_by", identity.uuid);

        if (renameError) throw renameError;

        const { error: deleteError } = await supabase
          .from("list_openings")
          .delete()
          .eq("list_id", editingListId);

        if (deleteError) throw deleteError;
      }

      const payload = listItems.map((item, index) => ({
        list_id: listId,
        anime_id: item.anime_id,
        anime_title: item.anime_title,
        opening_label: item.opening_label,
        youtube_video_id: item.youtube_video_id,
        thumbnail_url: item.thumbnail_url,
        order_index: index,
      }));

      const { error: insertError } = await supabase.from("list_openings").insert(payload);
      if (insertError) throw insertError;

      navigate("/");
    } catch (error) {
      alert(error.message || "Could not save list");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-12">
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
            <p className="text-slate-400">Build your perfect anime opening collection.</p>
          </div>
        </div>
        <button 
          className="btn-primary flex items-center gap-2"
          onClick={handleSaveList} 
          disabled={!canSave || saving}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {editingListId ? "Update List" : "Save List"}
        </button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Tools & Search */}
        <div className="lg:col-span-8 space-y-8">
          {/* Quick Builder */}
          <section className="card">
            <div className="flex items-center gap-2 mb-6">
              <Zap className="w-5 h-5 text-brand-400" />
              <h3 className="text-lg font-bold">Quick Builder</h3>
              <span className="pill text-[10px]">Auto-generate</span>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div className="space-y-2">
                <label className="text-xs text-slate-500 uppercase font-bold tracking-wider">List Name</label>
                <input
                  value={quickListName}
                  onChange={(e) => setQuickListName(e.target.value)}
                  placeholder="e.g. Best of 2024"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs text-slate-500 uppercase font-bold tracking-wider">Number of Openings</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={1}
                    max={YOUTUBE_POPULAR_LIST_MAX}
                    value={quickCount}
                    onChange={(e) => setQuickCount(Math.max(1, Math.min(YOUTUBE_POPULAR_LIST_MAX, Number(e.target.value) || 1)))}
                  />
                  <button 
                    className="btn-secondary whitespace-nowrap"
                    onClick={() => setQuickCount(YOUTUBE_POPULAR_LIST_MAX)}
                  >
                    Max ({YOUTUBE_POPULAR_LIST_MAX})
                  </button>
                </div>
              </div>
            </div>
            
            <button 
              className="btn-secondary w-full flex items-center justify-center gap-2"
              onClick={generatePopularListQuickly}
              disabled={isGeneratingQuickList}
            >
              {isGeneratingQuickList ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              Generate Popular List
            </button>
          </section>

          {/* Manual Search */}
          <section className="card">
            <div className="flex items-center gap-2 mb-6">
              <Search className="w-5 h-5 text-brand-400" />
              <h3 className="text-lg font-bold">Manual Search</h3>
            </div>

            <div className="relative mb-6">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchAnime()}
                placeholder="Search anime title (e.g. Jujutsu Kaisen)..."
                className="pl-12 h-12"
              />
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
              <button 
                className="absolute right-2 top-1/2 -translate-y-1/2 btn-primary !py-1.5 !px-4 text-sm"
                onClick={searchAnime}
                disabled={isSearching}
              >
                {isSearching ? "..." : "Search"}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[300px] overflow-y-auto pr-2 scrollbar-thin">
              {searchResults.map((anime) => (
                <button
                  key={anime.mal_id}
                  className="flex items-center gap-3 p-2 rounded-xl bg-slate-800/30 border border-slate-800 hover:border-brand-500/50 transition-all text-left group"
                  onClick={() => selectAnime(anime)}
                >
                  <img
                    src={anime.images?.jpg?.small_image_url || ""}
                    alt=""
                    className="w-12 h-12 rounded-lg object-cover"
                    referrerPolicy="no-referrer"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold truncate group-hover:text-brand-400 transition-colors">
                      {anime.title_english || anime.title}
                    </p>
                    <p className="text-[10px] text-slate-500 uppercase">{anime.type || 'TV'}</p>
                  </div>
                  <Plus className="w-4 h-4 text-slate-700 group-hover:text-brand-400" />
                </button>
              ))}
            </div>

            <AnimatePresence mode="wait">
              {selectedAnime && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="mt-8 pt-8 border-t border-slate-800"
                >
                  <div className="flex items-center gap-4 mb-6">
                    <img 
                      src={selectedAnime.images?.jpg?.image_url} 
                      className="w-16 h-24 rounded-lg object-cover shadow-xl" 
                      alt=""
                      referrerPolicy="no-referrer"
                    />
                    <div>
                      <h4 className="text-xl font-bold">{selectedAnime.title_english || selectedAnime.title}</h4>
                      <p className="text-sm text-slate-400">Select an opening to find on YouTube</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 mb-8">
                    {animeOpenings.map((op) => (
                      <button 
                        key={op} 
                        className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${
                          currentOpeningToAttach === op 
                            ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/20' 
                            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                        }`}
                        onClick={() => searchYouTube(op)}
                      >
                        {op}
                      </button>
                    ))}
                  </div>

                  {isYtSearching && (
                    <div className="flex items-center gap-3 text-slate-400 text-sm py-4">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Searching YouTube for "{currentOpeningToAttach}"...
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {ytResults.map((video) => (
                      <button
                        key={video.id.videoId}
                        className="flex flex-col p-3 rounded-xl bg-slate-900 border border-slate-800 hover:border-brand-500/50 transition-all text-left group"
                        onClick={() => addToList(video)}
                      >
                        <div className="flex items-start gap-3 mb-2">
                          <div className="relative flex-shrink-0">
                            <img 
                              src={video.snippet.thumbnails?.medium?.url} 
                              className="w-24 h-14 rounded-lg object-cover" 
                              alt="" 
                            />
                            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-lg">
                              <Play className="w-6 h-6 text-white" />
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold line-clamp-2 group-hover:text-brand-400 transition-colors">
                              {video.snippet.title}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center justify-between mt-auto">
                          <span className="text-[10px] text-slate-500 truncate max-w-[150px]">
                            {video.snippet.channelTitle}
                          </span>
                          {video.durationText && (
                            <span className="text-[10px] bg-slate-800 px-1.5 py-0.5 rounded text-slate-300">
                              {video.durationText}
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        </div>

        {/* Right Column: Preview & My Lists */}
        <div className="lg:col-span-4 space-y-8">
          <section className="card flex flex-col h-[600px]">
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
                className="font-bold text-lg border-none bg-slate-800/50 focus:ring-0"
              />
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin">
              {listItems.length === 0 ? (
                <div className="empty-state h-full flex flex-col items-center justify-center">
                  <Music className="w-12 h-12 text-slate-800 mb-4" />
                  <p className="text-sm">Your list is empty.</p>
                  <p className="text-xs text-slate-600 mt-1">Add openings to get started.</p>
                </div>
              ) : (
                listItems.map((item, idx) => (
                  <motion.div 
                    layout
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    key={`${item.anime_id}-${idx}`} 
                    className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/30 border border-slate-800 group"
                  >
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
                      <p className="text-[10px] text-slate-500">{item.opening_label}</p>
                    </div>
                    <button
                      className="p-2 text-slate-600 hover:text-red-400 transition-colors"
                      onClick={() => setListItems((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </motion.div>
                ))
              )}
            </div>
          </section>

          <section className="card">
            <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
              <Save className="w-5 h-5 text-brand-400" />
              Your Lists
            </h3>
            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2 scrollbar-thin">
              {myCustomLists.length === 0 ? (
                <p className="text-sm text-slate-500 italic">No custom lists yet.</p>
              ) : (
                myCustomLists.map((list) => (
                  <div key={list.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-900/50 border border-slate-800 hover:border-slate-700 transition-all group">
                    <span className="text-sm font-medium truncate flex-1 mr-2">{list.name}</span>
                    <div className="flex items-center gap-1">
                      <button
                        className={`p-2 rounded-lg transition-colors ${editingListId === list.id ? 'bg-brand-500 text-white' : 'text-slate-400 hover:bg-slate-800'}`}
                        onClick={() => startEditList(list.id)}
                      >
                        <Layout className="w-4 h-4" />
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
      </div>
    </div>
  );
}