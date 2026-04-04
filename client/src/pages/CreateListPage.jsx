import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../lib/api";
import { getIdentity } from "../lib/identity";
import { supabase } from "../lib/supabase";

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
    <main className="create-page">
      <div className="create-shell">
        <header className="create-header">
          <div>
            <button className="btn-secondary nav-back-btn" onClick={() => navigate("/")}>← Back to Lobby</button>
            <h1>Create Custom List</h1>
            <p>Create, edit, delete, or auto-generate custom lists from anime popularity.</p>
          </div>
          <button onClick={handleSaveList} disabled={!canSave || saving}>
            {editingListId ? "Update List" : "Save List"}
          </button>
        </header>

        <section className="card stack">
          <div className="section-head">
            <h3>Your Custom Lists</h3>
            <small>Only lists created by your logged identity appear here.</small>
          </div>

          {myCustomLists.length === 0 ? (
            <div className="empty-state">No custom lists yet. Create one from the quick builder or manually.</div>
          ) : (
            <div className="stack">
              {myCustomLists.map((list) => (
                <div key={list.id} className="list-item">
                  <strong>{list.name}</strong>
                  <div className="row gap">
                    <button
                      className={editingListId === list.id ? "active" : "btn-secondary"}
                      onClick={() => startEditList(list.id)}
                    >
                      {editingListId === list.id ? "Editing" : "Edit"}
                    </button>
                    <button
                      className="btn-ghost btn-danger"
                      onClick={() => handleDeleteList(list.id)}
                      disabled={deletingListId === list.id}
                    >
                      {deletingListId === list.id ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="create-grid">
          <section className="create-left card stack">
            <section className="sub-card stack">
              <div className="row spread center wrap gap">
                <h3>Quick Builder</h3>
                <span className="pill">By popularity</span>
              </div>

              <small>
                Generate a list from the most popular anime and auto-pick opening videos.
              </small>

              <input
                value={quickListName}
                onChange={(e) => setQuickListName(e.target.value)}
                placeholder="Quick list name (optional)"
              />

              <div className="row gap center wrap">
                <label htmlFor="quick-count">Openings</label>
                <input
                  id="quick-count"
                  type="number"
                  min={1}
                  max={YOUTUBE_POPULAR_LIST_MAX}
                  value={quickCount}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    if (!Number.isFinite(next)) {
                      setQuickCount(1);
                      return;
                    }
                    setQuickCount(Math.max(1, Math.min(YOUTUBE_POPULAR_LIST_MAX, next)));
                  }}
                />
                <button
                  className="btn-ghost"
                  onClick={() => setQuickCount(YOUTUBE_POPULAR_LIST_MAX)}
                >
                  Max ({YOUTUBE_POPULAR_LIST_MAX})
                </button>
                <button
                  className="btn-secondary"
                  onClick={generatePopularListQuickly}
                  disabled={isGeneratingQuickList}
                >
                  {isGeneratingQuickList ? "Generating..." : "Generate Popular List"}
                </button>
              </div>
            </section>

            <div className="row spread center wrap gap">
              <h3>Manual Builder</h3>
              <div className="row gap">
                <select value={editingListId} onChange={(e) => startEditList(e.target.value)}>
                <option value="">New list</option>
                {myCustomLists.map((list) => (
                  <option key={list.id} value={list.id}>Edit: {list.name}</option>
                ))}
                </select>
                {editingListId && (
                  <button className="btn-ghost" onClick={resetEditor}>Clear editor</button>
                )}
              </div>
            </div>

            <small>1) Search anime and add openings one by one.</small>

            <div className="row gap">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchAnime()}
                placeholder="Search anime title..."
              />
              <button className="btn-secondary" onClick={searchAnime} disabled={isSearching}>
                {isSearching ? "..." : "Search"}
              </button>
            </div>

            <div className="scroll-box">
              {searchResults.map((anime) => (
                <button
                  key={anime.mal_id}
                  className="list-pick"
                  onClick={() => selectAnime(anime)}
                >
                  <img
                    src={anime.images?.jpg?.small_image_url || anime.images?.jpg?.image_url || ""}
                    alt={anime.title}
                    className="thumb-cover"
                    referrerPolicy="no-referrer"
                  />
                  <span>{anime.title_english || anime.title}</span>
                </button>
              ))}
            </div>

            {selectedAnime && (
              <section className="sub-card stack">
                <h3>2) Pick Opening</h3>
                <div className="scroll-box small">
                  {animeOpenings.map((op) => (
                    <button key={op} className="btn-ghost" onClick={() => searchYouTube(op)}>
                      {op}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {(ytResults.length > 0 || isYtSearching) && (
              <section className="sub-card stack">
                <h3>3) Select Video</h3>
                {isYtSearching && <small>Searching curated results...</small>}
                <div className="scroll-box small">
                  {ytResults.map((video) => (
                    <button
                      key={video.id.videoId}
                      className="video-choice"
                      onClick={() => addToList(video)}
                    >
                      <strong>{video.snippet.title}</strong>
                      <small>
                        {video.snippet.channelTitle}
                        {video.durationText ? ` • ${video.durationText}` : ""}
                      </small>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </section>

          <section className="create-right card stack">
            <h3>List Preview</h3>
            <input
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              placeholder="Name your list..."
            />

            <div className="scroll-box tall">
              {listItems.length === 0 ? (
                <div className="empty-state">Your list is empty. Add openings from the left panel.</div>
              ) : (
                listItems.map((item, idx) => (
                  <div key={`${item.anime_id}-${idx}`} className="queue-item">
                    <img
                      src={item.thumbnail_url || ""}
                      alt={item.anime_title}
                      className="queue-thumb"
                      referrerPolicy="no-referrer"
                    />
                    <div>
                      <strong>{item.anime_title}</strong>
                      <p>{item.opening_label}</p>
                    </div>
                    <button
                      className="btn-ghost"
                      onClick={() => setListItems((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      Remove
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
