import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "../lib/api";
import { getIdentity, saveIdentity } from "../lib/identity";
import { supabase } from "../lib/supabase";

export default function LobbyPage() {
  const navigate = useNavigate();
  const [identity, setIdentity] = useState(getIdentity());

  const [displayName, setDisplayName] = useState(identity?.displayName || "");
  const [lists, setLists] = useState([]);
  const [rooms, setRooms] = useState([]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [selectedList, setSelectedList] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [inviteCode, setInviteCode] = useState("");

  useEffect(() => {
    loadLists();
    loadPublicRooms();
  }, []);

  async function loadLists() {
    const { data, error } = await supabase
      .from("lists")
      .select("id,name,is_preset,created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) return;
    setLists(data || []);
    if (!selectedList && data?.[0]?.id) setSelectedList(data[0].id);
  }

  async function loadPublicRooms() {
    try {
      const data = await apiGet("/api/rooms/public");
      setRooms(data.rooms || []);
    } catch {
      setRooms([]);
    }
  }

  function ensureIdentity() {
    const trimmed = displayName.trim();
    if (!trimmed) {
      alert("Enter a display name first");
      return null;
    }

    const saved = saveIdentity(trimmed);
    setIdentity(saved);
    return saved;
  }

  async function createRoom() {
    const currentIdentity = ensureIdentity();
    if (!currentIdentity) return;
    if (!newRoomName.trim() || !selectedList) return;

    const data = await apiPost("/api/rooms", {
      name: newRoomName.trim(),
      listId: selectedList,
      userUuid: currentIdentity.uuid,
      displayName: currentIdentity.displayName,
      isPublic,
    });

    navigate(`/room/${data.room.id}`);
  }

  async function joinByCode() {
    const currentIdentity = ensureIdentity();
    if (!currentIdentity || !inviteCode.trim()) return;
    try {
      const data = await apiGet(`/api/rooms/by-code/${inviteCode.trim().toUpperCase()}`);
      navigate(`/room/${data.room.id}`);
    } catch {
      alert("Invalid room code");
    }
  }

  async function generateSampleList() {
    const currentIdentity = ensureIdentity();
    if (!currentIdentity) return;

    try {
      const generated = await apiGet("/api/lists/preset/top-mal-openings?limit=10");
      const { data: list, error: listError } = await supabase
        .from("lists")
        .insert({
          name: "Top 10 MAL Openings",
          created_by: currentIdentity.uuid,
          is_preset: true,
        })
        .select("id")
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

      await loadLists();
      setSelectedList(list.id);
    } catch {
      alert("Could not generate preset list");
    }
  }

  return (
    <main className="lobby-page">
      <div className="lobby-shell">
        <header className="hero lobby-hero">
          <div className="hero-copy">
            <span className="eyebrow">Anime Opening Rater</span>
            <h1>Watch. Rate. Rank.</h1>
            <p>Create a room, invite your friends, and decide the best anime opening together.</p>
          </div>
          <div className="lobby-hero-meta stack">
            <div className="pill">{identity?.displayName || "Guest"}</div>
            <div className="pill host">{rooms.length} public rooms</div>
          </div>
        </header>

        <section className="lobby-command-grid">
          <div className="lobby-left-column stack">
            <section className="card stack lobby-identity-card">
              <div className="section-head">
                <h3>Your Identity</h3>
                <span className="pill">{displayName.trim() ? "Ready" : "Required"}</span>
              </div>
              <p className="muted">Set your player name before creating or joining rooms.</p>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Enter display name..."
              />
            </section>

            <section className="card stack lobby-actions-card">
              <h3>Start Session</h3>
              <p className="muted">Create a room with your list setup, or build a list first.</p>
              <div className="lobby-action-grid">
                <button onClick={() => setShowCreateModal(true)} disabled={!displayName.trim()}>
                  Create New Room
                </button>
                <button className="btn-secondary" onClick={() => navigate("/create-list")}>
                  Create Custom List
                </button>
              </div>
            </section>

            <section className="card stack">
              <h3>Join Private Room</h3>
              <p className="muted">Got a room code? Join directly.</p>
              <div className="row gap lobby-join-row">
                <input
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                  placeholder="Invite code"
                />
                <button className="btn-secondary" onClick={joinByCode}>Join</button>
              </div>
            </section>
          </div>

          <section className="card stack lobby-rooms-card">
            <div className="section-head">
              <h3>Active Public Rooms</h3>
              <button className="btn-ghost" onClick={loadPublicRooms}>Refresh</button>
            </div>

            {rooms.length === 0 ? (
              <p className="empty-state">No public rooms active. Create one.</p>
            ) : (
              <div className="public-room-grid">
                {rooms.map((room) => (
                  <button
                    key={room.id}
                    className="room-card lobby-room-card"
                    onClick={() => {
                      const currentIdentity = ensureIdentity();
                      if (!currentIdentity) return;
                      navigate(`/room/${room.id}`);
                    }}
                  >
                    <div className="room-card-title-row">
                      <strong>{room.name}</strong>
                      <span className="room-card-badge">Public</span>
                    </div>
                    <div className="room-card-meta-row">
                      <p>Code: {room.invite_code}</p>
                      <small>{room.lists?.name || "Custom list"}</small>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </section>
      </div>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <h3>Create Room</h3>
            <input
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder="Room name"
            />

            <select value={selectedList} onChange={(e) => setSelectedList(e.target.value)}>
              <option value="">Choose a list...</option>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>{list.name}</option>
              ))}
            </select>

            {lists.length === 0 && (
              <button className="btn-ghost" onClick={generateSampleList}>
                Generate Top MAL sample list
              </button>
            )}

            <label className="row gap center">
              <input
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
              />
              Public room
            </label>

            <div className="row gap">
              <button className="btn-ghost" onClick={() => setShowCreateModal(false)}>Cancel</button>
              <button onClick={createRoom} disabled={!newRoomName.trim() || !selectedList}>Launch Room</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
