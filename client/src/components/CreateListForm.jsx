import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../lib/api";
import { supabase } from "../lib/supabase";

function sanitizeOpeningLabel(value) {
  if (!value) return "OP1";
  return String(value).replace(/^\d+\s*[:-]\s*/g, "").trim();
}

export default function CreateListForm({ identity, onListCreated, availableLists = [] }) {
  const [mode, setMode] = useState("preset");
  const [listName, setListName] = useState("");
  const [loading, setLoading] = useState(false);
  const [animeSearch, setAnimeSearch] = useState("");
  const [animeResults, setAnimeResults] = useState([]);
  const [animeSearchLoading, setAnimeSearchLoading] = useState(false);
  const [customOpenings, setCustomOpenings] = useState([]);
  const [youtubeResults, setYoutubeResults] = useState({});
  const [youtubeLoadingByIndex, setYoutubeLoadingByIndex] = useState({});
  const [editingListId, setEditingListId] = useState("");

  const canCreateCustom = useMemo(() => listName.trim() && customOpenings.length > 0, [listName, customOpenings]);
  const editableLists = useMemo(
    () =>
      (availableLists || []).filter(
        (list) => !list.is_preset && list.created_by === identity.userId,
      ),
      [availableLists, identity.userId],
  );

  useEffect(() => {
    const timeout = setTimeout(async () => {
      if (animeSearch.trim().length < 2 || mode !== "custom") return;
      setAnimeSearchLoading(true);
      try {
        const data = await apiGet(`/api/jikan/search-anime?q=${encodeURIComponent(animeSearch)}`);
        setAnimeResults(data.data || []);
      } catch {
        setAnimeResults([]);
      } finally {
        setAnimeSearchLoading(false);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [animeSearch, mode]);

  async function createPresetList() {
    setLoading(true);
    try {
      const generated = await apiGet("/api/lists/preset/top-mal-openings?limit=25");
      const finalName = listName.trim() || "Top MAL Openings";
      const { data: list, error: listError } = await supabase
        .from("lists")
        .insert({
          name: finalName,
          created_by: identity.userId,
          is_preset: true,
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

      setListName("");
      onListCreated?.(list);
    } catch (error) {
      alert(error.message || "Failed to create preset list");
    } finally {
      setLoading(false);
    }
  }

  async function searchYoutubeForOpening(openingIndex) {
    const opening = customOpenings[openingIndex];
    if (!opening) return;

    const query = `${opening.anime_title} ${opening.opening_label} opening official crunchyroll tv size 1:30`;
    setYoutubeLoadingByIndex((prev) => ({ ...prev, [openingIndex]: true }));
    try {
      const data = await apiGet(`/api/youtube/search?q=${encodeURIComponent(query)}`);
      setYoutubeResults((prev) => ({
        ...prev,
        [openingIndex]: data.items || [],
      }));
    } catch {
      setYoutubeResults((prev) => ({
        ...prev,
        [openingIndex]: [],
      }));
    } finally {
      setYoutubeLoadingByIndex((prev) => ({ ...prev, [openingIndex]: false }));
    }
  }

  function buildOpeningsPayload(listId) {
    return customOpenings.map((item, index) => ({
      list_id: listId,
      anime_id: item.anime_id,
      anime_title: item.anime_title,
      opening_label: item.opening_label,
      youtube_video_id: item.youtube_video_id,
      thumbnail_url: item.thumbnail_url,
      order_index: index,
    }));
  }

  function resetCustomEditor() {
    setEditingListId("");
    setListName("");
    setAnimeSearch("");
    setAnimeResults([]);
    setCustomOpenings([]);
    setYoutubeResults({});
    setYoutubeLoadingByIndex({});
  }

  async function createCustomList() {
    setLoading(true);
    try {
      const { data: list, error: listError } = await supabase
        .from("lists")
        .insert({
          name: listName.trim(),
          created_by: identity.userId,
          is_preset: false,
        })
        .select("id,name")
        .single();

      if (listError) throw listError;

      const payload = buildOpeningsPayload(list.id);

      const { error: openingError } = await supabase.from("list_openings").insert(payload);
      if (openingError) throw openingError;

      resetCustomEditor();
      onListCreated?.(list);
    } catch (error) {
      alert(error.message || "Failed to create custom list");
    } finally {
      setLoading(false);
    }
  }

  async function updateCustomList() {
    if (!editingListId || !canCreateCustom) return;

    setLoading(true);
    try {
      const { error: listError } = await supabase
        .from("lists")
        .update({ name: listName.trim() })
        .eq("id", editingListId)
        .eq("created_by", identity.userId)
        .eq("is_preset", false);

      if (listError) throw listError;

      const { error: deleteError } = await supabase
        .from("list_openings")
        .delete()
        .eq("list_id", editingListId);

      if (deleteError) throw deleteError;

      const payload = buildOpeningsPayload(editingListId);
      if (payload.length > 0) {
        const { error: insertError } = await supabase.from("list_openings").insert(payload);
        if (insertError) throw insertError;
      }

      onListCreated?.();
      alert("List updated successfully");
    } catch (error) {
      alert(error.message || "Failed to update list");
    } finally {
      setLoading(false);
    }
  }

  async function loadListForEditing(listId) {
    if (!listId) {
      resetCustomEditor();
      return;
    }

    const selected = editableLists.find((list) => list.id === listId);
    if (!selected) return;

    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("list_openings")
        .select("id,anime_id,anime_title,opening_label,youtube_video_id,thumbnail_url,order_index")
        .eq("list_id", listId)
        .order("order_index", { ascending: true });

      if (error) throw error;

      setEditingListId(listId);
      setListName(selected.name || "");
      setCustomOpenings(
        (data || []).map((item) => ({
          ...item,
          opening_options: [item.opening_label || "OP1"],
          selected_video_title: "",
          selected_video_channel: "",
        })),
      );
      setYoutubeResults({});
      setYoutubeLoadingByIndex({});
    } catch (error) {
      alert(error.message || "Failed to load list");
    } finally {
      setLoading(false);
    }
  }

  async function addAnime(anime) {
    const alreadyExists = customOpenings.some((item) => item.anime_id === anime.mal_id);
    if (alreadyExists) return;

    let openingOptions = ["OP1"];
    try {
      const themes = await apiGet(`/api/jikan/anime/${anime.mal_id}/themes`);
      const fromApi = (themes?.data?.openings || [])
        .map((label) => sanitizeOpeningLabel(label))
        .filter(Boolean);
      if (fromApi.length > 0) openingOptions = fromApi;
    } catch {
      // ignore
    }

    setCustomOpenings((prev) => [
      ...prev,
      {
        anime_id: anime.mal_id,
        anime_title: anime.title_english || anime.title,
        opening_label: openingOptions[0],
        opening_options: openingOptions,
        youtube_video_id: "",
        thumbnail_url: anime.images?.jpg?.image_url || "",
        selected_video_title: "",
        selected_video_channel: "",
      },
    ]);
  }

  return (
    <div className="card stack">
      <div className="hero-copy">
        <span className="eyebrow">List builder</span>
        <h3>{editingListId ? "Edit custom list" : "Create list"}</h3>
      </div>
      <div className="row gap">
        <button className={mode === "preset" ? "active" : ""} onClick={() => setMode("preset")}>Preset</button>
        <button className={`btn-secondary ${mode === "custom" ? "active" : ""}`} onClick={() => setMode("custom")}>Custom</button>
      </div>

      <label htmlFor="list-name-input">List name</label>
      <input
        id="list-name-input"
        value={listName}
        onChange={(e) => setListName(e.target.value)}
        placeholder={mode === "preset" ? "List name (optional)" : "Custom list name"}
      />

      {mode === "preset" ? (
        <button disabled={loading} onClick={createPresetList}>Generate from top MAL + YouTube</button>
      ) : (
        <>
          <div className="row spread center wrap gap">
            <label htmlFor="anime-search-input">1) Search anime</label>
            <div className="row gap">
              <select
                value={editingListId}
                onChange={(e) => loadListForEditing(e.target.value)}
                disabled={loading}
              >
                <option value="">New custom list</option>
                {editableLists.map((list) => (
                  <option key={list.id} value={list.id}>
                    Edit: {list.name}
                  </option>
                ))}
              </select>
              {editingListId && (
                <button className="btn-ghost" onClick={resetCustomEditor}>
                  Clear editor
                </button>
              )}
            </div>
          </div>

          <input
            id="anime-search-input"
            value={animeSearch}
            onChange={(e) => setAnimeSearch(e.target.value)}
            placeholder="Search anime (Jikan)"
          />

          <div className="scroll-box">
            {animeSearchLoading && <small>Searching anime...</small>}
            {animeResults.map((anime) => (
              <div key={anime.mal_id} className="list-item">
                <div className="row gap center">
                  <img
                    src={anime.images?.jpg?.small_image_url || anime.images?.jpg?.image_url || ""}
                    alt={anime.title_english || anime.title}
                    className="thumb-cover"
                    referrerPolicy="no-referrer"
                  />
                  <span>{anime.title_english || anime.title}</span>
                </div>
                <button className="btn-secondary" onClick={() => addAnime(anime)}>Add</button>
              </div>
            ))}
          </div>

          <label>2) Configure opening and video</label>
          {customOpenings.map((opening, index) => (
            <div key={`${opening.anime_id}-${index}`} className="card mini-card">
              <div className="row spread center">
                <div className="row gap center">
                  <img
                    src={opening.thumbnail_url || ""}
                    alt={opening.anime_title}
                    className="thumb-cover large"
                    referrerPolicy="no-referrer"
                  />
                  <strong>{opening.anime_title}</strong>
                </div>
                <button
                  className="btn-ghost"
                  onClick={() =>
                    setCustomOpenings((prev) => prev.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </button>
              </div>

              <div className="row gap wrap center">
                <label htmlFor={`opening-label-${index}`}>Opening label</label>
                {(opening.opening_options || []).length > 1 ? (
                  <select
                    id={`opening-label-${index}`}
                    value={opening.opening_label}
                    onChange={(e) => {
                      const value = e.target.value;
                      setCustomOpenings((prev) =>
                        prev.map((item, i) => (i === index ? { ...item, opening_label: value } : item)),
                      );
                    }}
                  >
                    {(opening.opening_options || []).map((label) => (
                      <option key={label} value={label}>
                        {label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`opening-label-${index}`}
                    value={opening.opening_label}
                    onChange={(e) => {
                      const value = e.target.value;
                      setCustomOpenings((prev) =>
                        prev.map((item, i) => (i === index ? { ...item, opening_label: value } : item)),
                      );
                    }}
                  />
                )}
                <button className="btn-secondary" onClick={() => searchYoutubeForOpening(index)}>Find YouTube</button>
              </div>

              <div className="scroll-box small">
                {youtubeLoadingByIndex[index] && <small>Searching videos...</small>}
                {(youtubeResults[index] || []).map((video) => (
                  <button
                    key={video.id.videoId}
                    className="video-choice"
                    onClick={() => {
                      setCustomOpenings((prev) =>
                        prev.map((item, i) =>
                          i === index
                            ? {
                                ...item,
                                youtube_video_id: video.id.videoId,
                                thumbnail_url:
                                  video.snippet.thumbnails?.medium?.url || item.thumbnail_url,
                                selected_video_title: video.snippet.title,
                                selected_video_channel: video.snippet.channelTitle,
                              }
                            : item,
                        ),
                      );
                    }}
                  >
                    <strong>{video.snippet.title}</strong>
                    <small>
                      {video.snippet.channelTitle}
                      {video.durationText ? ` • ${video.durationText}` : ""}
                    </small>
                  </button>
                ))}
              </div>

              <small>
                Selected video: {opening.youtube_video_id || "none"}
                {opening.selected_video_channel ? ` • ${opening.selected_video_channel}` : ""}
              </small>
            </div>
          ))}

          <label>3) Save your list</label>
          {editingListId ? (
            <button disabled={!canCreateCustom || loading} onClick={updateCustomList}>
              Update custom list
            </button>
          ) : (
            <button disabled={!canCreateCustom || loading} onClick={createCustomList}>
              Save custom list
            </button>
          )}
        </>
      )}
    </div>
  );
}
