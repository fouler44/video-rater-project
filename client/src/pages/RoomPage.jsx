import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiPost } from "../lib/api";
import { getIdentity } from "../lib/identity";
import { supabase } from "../lib/supabase";

const PARTYKIT_URL = import.meta.env.VITE_PARTYKIT_URL || "ws://localhost:1999";

export default function RoomPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const identity = getIdentity();
  const wsRef = useRef(null);
  const iframeRef = useRef(null);
  const [ratingInput, setRatingInput] = useState(5);

  const [room, setRoom] = useState(null);
  const [openings, setOpenings] = useState([]);
  const [ratings, setRatings] = useState([]);
  const [roomMembers, setRoomMembers] = useState([]);
  const [presence, setPresence] = useState([]);
  const [hostUuid, setHostUuid] = useState("");

  const currentOpening = openings[room?.current_opening_index || 0];
  const isHost = identity?.uuid && hostUuid && identity.uuid === hostUuid;

  const ratingsByOpening = useMemo(() => {
    const grouped = new Map();
    for (const rating of ratings) {
      const key = rating.list_opening_id;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(rating);
    }
    return grouped;
  }, [ratings]);

  const currentRatings = currentOpening ? ratingsByOpening.get(currentOpening.id) || [] : [];
  const currentRatedCount = presence.filter((member) =>
    currentRatings.some((rating) => rating.user_uuid === member.userUuid)
  ).length;
  const allPresentRated = presence.length > 0 && currentRatedCount === presence.length;

  const myCurrentRating = currentOpening
    ? currentRatings.find((r) => r.user_uuid === identity?.uuid)?.score || 5
    : 5;

  const ratedUserIds = useMemo(() => new Set(currentRatings.map((rating) => rating.user_uuid)), [currentRatings]);

  const playersView = useMemo(() => {
    const byUser = new Map();
    const scoreByUser = new Map(currentRatings.map((rating) => [rating.user_uuid, rating.score]));
    const submittedAtByUser = new Map(currentRatings.map((rating) => [rating.user_uuid, rating.submitted_at || ""]));

    const normalizeDisplayName = (value = "") => String(value).trim().toLowerCase();

    const upsertRawUser = ({ userUuid, displayName, isOnline }) => {
      const safeDisplayName = String(displayName || "").trim() || `User ${String(userUuid).slice(0, 6)}`;
      const existing = byUser.get(userUuid);
      if (existing) {
        byUser.set(userUuid, {
          ...existing,
          displayName: safeDisplayName,
          isOnline: existing.isOnline || isOnline,
        });
        return;
      }

      byUser.set(userUuid, {
        userUuid,
        displayName: safeDisplayName,
        isOnline,
      });
    };

    for (const member of roomMembers) {
      upsertRawUser({
        userUuid: member.user_uuid,
        displayName: member.display_name,
        isOnline: false,
      });
    }

    for (const online of presence) {
      upsertRawUser({
        userUuid: online.userUuid,
        displayName: online.displayName,
        isOnline: true,
      });
    }

    for (const rating of currentRatings) {
      if (!byUser.has(rating.user_uuid)) {
        upsertRawUser({
          userUuid: rating.user_uuid,
          displayName: `User ${String(rating.user_uuid).slice(0, 6)}`,
          isOnline: false,
        });
      }
    }

    const byName = new Map();
    for (const item of byUser.values()) {
      const nameKey = normalizeDisplayName(item.displayName) || `user:${item.userUuid}`;
      const candidateVoted = ratedUserIds.has(item.userUuid);
      const candidateSubmittedAt = submittedAtByUser.get(item.userUuid) || "";
      const candidateScore = scoreByUser.get(item.userUuid);

      if (!byName.has(nameKey)) {
        byName.set(nameKey, {
          key: nameKey,
          displayName: item.displayName,
          userUuids: [item.userUuid],
          userCount: 1,
          isOnline: item.isOnline,
          isYou: item.userUuid === identity?.uuid,
          isHost: item.userUuid === hostUuid,
          voted: candidateVoted,
          score: candidateScore,
          submittedAt: candidateSubmittedAt,
        });
        continue;
      }

      const merged = byName.get(nameKey);
      merged.userUuids.push(item.userUuid);
      merged.userCount += 1;
      merged.isOnline = merged.isOnline || item.isOnline;
      merged.isYou = merged.isYou || item.userUuid === identity?.uuid;
      merged.isHost = merged.isHost || item.userUuid === hostUuid;

      if (candidateVoted) {
        if (!merged.voted || candidateSubmittedAt > merged.submittedAt) {
          merged.voted = true;
          merged.score = candidateScore;
          merged.submittedAt = candidateSubmittedAt;
        }
      }
    }

    return Array.from(byName.values())
      .sort((a, b) => {
        if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
        if (a.voted !== b.voted) return a.voted ? -1 : 1;
        return a.displayName.localeCompare(b.displayName);
      });
  }, [roomMembers, presence, currentRatings, ratedUserIds, identity?.uuid, hostUuid]);

  useEffect(() => {
    setRatingInput(myCurrentRating);
  }, [currentOpening?.id, myCurrentRating]);

  function normalizeDisplayName(value = "") {
    return String(value).trim().toLowerCase();
  }

  async function cleanupDuplicateMembers(members = []) {
    if (!roomId || members.length === 0) return members;

    const grouped = new Map();
    for (const member of members) {
      const key = normalizeDisplayName(member.display_name);
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(member);
    }

    const toDelete = [];
    for (const bucket of grouped.values()) {
      if (bucket.length <= 1) continue;

      const sorted = [...bucket].sort(
        (a, b) => new Date(b.joined_at || 0).getTime() - new Date(a.joined_at || 0).getTime()
      );

      // Keep the most recent session for this display name and prune older duplicates.
      const [, ...older] = sorted;
      toDelete.push(...older.map((item) => item.user_uuid));
    }

    if (toDelete.length === 0) return members;

    const uniqueToDelete = [...new Set(toDelete)];
    const { error } = await supabase
      .from("room_members")
      .delete()
      .eq("room_id", roomId)
      .in("user_uuid", uniqueToDelete);

    if (error) {
      console.warn("Could not cleanup duplicate room members", error.message);
      return members;
    }

    return members.filter((member) => !uniqueToDelete.includes(member.user_uuid));
  }

  async function loadRoomData() {
    const { data: roomData, error: roomError } = await supabase
      .from("rooms")
      .select("id,name,list_id,host_uuid,current_opening_index,status")
      .eq("id", roomId)
      .single();

    if (roomError) {
      alert(roomError.message);
      navigate("/");
      return;
    }

    const { data: openingsData, error: openingsError } = await supabase
      .from("list_openings")
      .select("id,anime_title,opening_label,youtube_video_id,thumbnail_url,order_index")
      .eq("list_id", roomData.list_id)
      .order("order_index", { ascending: true });

    if (openingsError) {
      alert(openingsError.message);
      return;
    }

    const { data: ratingsData, error: ratingsError } = await supabase
      .from("ratings")
      .select("id,room_id,list_opening_id,user_uuid,score,submitted_at")
      .eq("room_id", roomId);

    if (ratingsError) {
      alert(ratingsError.message);
      return;
    }

    const { data: membersData, error: membersError } = await supabase
      .from("room_members")
      .select("user_uuid,display_name,joined_at")
      .eq("room_id", roomId);

    if (membersError) {
      alert(membersError.message);
      return;
    }

    const cleanedMembers = await cleanupDuplicateMembers(membersData || []);

    setRoom(roomData);
    setHostUuid(roomData.host_uuid);
    setOpenings(openingsData || []);
    setRatings(ratingsData || []);
    setRoomMembers(cleanedMembers || []);
  }

  async function upsertMember() {
    if (!identity) return;

    await supabase.from("room_members").upsert({
      room_id: roomId,
      user_uuid: identity.uuid,
      display_name: identity.displayName,
    });
  }

  useEffect(() => {
    if (!identity) {
      navigate("/");
      return;
    }

    loadRoomData();
    upsertMember();
  }, [roomId]);

  useEffect(() => {
    if (!identity) return;

    const url = `${PARTYKIT_URL}/party/anime-room/${roomId}?userUuid=${identity.uuid}&displayName=${encodeURIComponent(identity.displayName)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "presence:update") {
        setPresence(message.payload.members || []);
        if (message.payload.hostUuid) setHostUuid(message.payload.hostUuid);
      }

      if (["player:play", "player:pause", "player:seek"].includes(message.type)) {
        const iframeWindow = iframeRef.current?.contentWindow;
        if (!iframeWindow) return;

        if (message.type === "player:play") {
          iframeWindow.postMessage('{"event":"command","func":"playVideo","args":""}', "*");
        }

        if (message.type === "player:pause") {
          iframeWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', "*");
        }

        if (message.type === "player:seek") {
          iframeWindow.postMessage(
            JSON.stringify({
              event: "command",
              func: "seekTo",
              args: [Number(message.payload.seconds || 0), true],
            }),
            "*"
          );
        }
      }

      if (message.type === "opening:next") {
        setRoom((prev) => ({
          ...prev,
          current_opening_index: message.payload.nextIndex,
        }));
      }

      if (message.type === "rating:submitted") {
        setRatings((prev) => {
          const other = prev.filter(
            (item) =>
              !(
                item.list_opening_id === message.payload.listOpeningId &&
                item.user_uuid === message.payload.userUuid
              )
          );
          return [
            ...other,
            {
              room_id: roomId,
              list_opening_id: message.payload.listOpeningId,
              user_uuid: message.payload.userUuid,
              score: message.payload.score,
              submitted_at: new Date().toISOString(),
            },
          ];
        });
      }
    };

    return () => ws.close();
  }, [roomId, identity?.uuid]);

  function sendWs(message) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }

  async function submitRating(score) {
    if (!currentOpening || !identity || room?.status !== "active") return;

    const payload = {
      room_id: roomId,
      list_opening_id: currentOpening.id,
      user_uuid: identity.uuid,
      score,
      submitted_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("ratings")
      .upsert(payload, { onConflict: "room_id,list_opening_id,user_uuid" });

    if (error) {
      alert(error.message);
      return;
    }

    setRatings((prev) => {
      const filtered = prev.filter(
        (item) => !(item.list_opening_id === currentOpening.id && item.user_uuid === identity.uuid)
      );
      return [...filtered, payload];
    });

    sendWs({
      type: "rating:submitted",
      payload: {
        listOpeningId: currentOpening.id,
        userUuid: identity.uuid,
        score,
      },
    });
  }

  async function submitRatingFromInput() {
    const value = Math.max(1, Math.min(10, Number(ratingInput) || 5));
    setRatingInput(value);
    await submitRating(value);
  }

  async function goToOpening(targetIndex) {
    if (!isHost || !room || targetIndex < 0 || targetIndex >= openings.length) return;

    // Si no es el siguiente, pedir confirmación si no todos han votado
    if (targetIndex !== room.current_opening_index + 1 && !allPresentRated) {
      const unanswered = presence.length - currentRatedCount;
      const ok = window.confirm(`${unanswered} users haven't rated yet. Jump anyway?`);
      if (!ok) return;
    }

    if (targetIndex === openings.length - 1) {
      const confirmFinish = window.confirm("This is the last opening. Finish session after this?");
      if (confirmFinish) {
        await apiPost(`/api/rooms/${roomId}/end`, {});
        navigate(`/room/${roomId}/rankings`);
        return;
      }
    }

    await apiPost(`/api/rooms/${roomId}/advance`, { nextIndex: targetIndex });
    setRoom((prev) => ({ ...prev, current_opening_index: targetIndex }));
    sendWs({ type: "opening:next", payload: { nextIndex: targetIndex } });
  }

  async function goNextOpening() {
    if (!isHost || !room) return;

    if (!allPresentRated) {
      const unanswered = presence.length - currentRatedCount;
      const ok = window.confirm(`${unanswered} users haven't rated yet. Skip anyway?`);
      if (!ok) return;
    }

    const nextIndex = room.current_opening_index + 1;
    if (nextIndex >= openings.length) {
      await apiPost(`/api/rooms/${roomId}/end`, {});
      navigate(`/room/${roomId}/rankings`);
      return;
    }

    await apiPost(`/api/rooms/${roomId}/advance`, { nextIndex });
    setRoom((prev) => ({ ...prev, current_opening_index: nextIndex }));
    sendWs({ type: "opening:next", payload: { nextIndex } });
  }

  if (!room) return <main className="container app-shell"><p>Loading room...</p></main>;

  if (room.status === "finished") {
    return (
      <main className="room-page">
        <section className="modal-card stack" style={{ maxWidth: 620, margin: "6rem auto" }}>
          <span className="eyebrow">Session finished</span>
          <h2>{room.name}</h2>
          <p>All openings were rated. You can view the final results now.</p>
          <div className="row gap nav-buttons">
            <Link className="button-link btn-primary" to={`/room/${roomId}/rankings`}>🏆 View Rankings</Link>
            <Link className="button-link btn-secondary" to="/">← Back to Lobby</Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="room-page">
      <div className="room-shell">
      <header className="section-head room-head">
        <div className="hero-copy">
          <span className="eyebrow">Live room</span>
          <h1>{room.name}</h1>
          <p>
            Host: {hostUuid === identity?.uuid ? "You" : hostUuid?.slice(0, 8)} {isHost ? "(Host)" : ""}
          </p>
        </div>
        <div className="row gap">
          <span className="pill host">{presence.length} online</span>
          <span className="code-chip mono">{roomId.slice(0, 8).toUpperCase()}</span>
          <Link className="button-link btn-ghost nav-btn" to="/">🏠 Lobby</Link>
          <Link className="button-link btn-secondary nav-btn" to={`/room/${roomId}/rankings`}>🏆 Rankings</Link>
        </div>
      </header>

      <section className="room-layout modern-room-layout">
        <div className="card stack room-main-card">
          <div className="row spread center wrap gap">
            <div>
              <h3 className="room-opening-title">
                {currentOpening
                  ? `${currentOpening.anime_title} — ${currentOpening.opening_label}`
                  : "No opening"}
              </h3>
              <small className="muted">
                {currentOpening ? "Rate with the single input below, then submit your vote." : "Waiting for openings."}
              </small>
            </div>
            <span className="pill">{currentRatedCount}/{presence.length || 0} voted</span>
          </div>

          {currentOpening?.youtube_video_id ? (
            <iframe
              ref={iframeRef}
              title="YouTube player"
              className="player room-player"
              src={`https://www.youtube.com/embed/${currentOpening.youtube_video_id}?enablejsapi=1&playsinline=1`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          ) : (
            <p>No YouTube video selected for this opening.</p>
          )}

          <div className="rating-panel">
            <div className="row spread center wrap gap">
              <div>
                <h3>Vote</h3>
              </div>
              <small className="muted">Your score: {myCurrentRating}/10</small>
            </div>

            <div className="rating-form row gap center wrap">
              <label className="rating-label" htmlFor="rating-input">Score</label>
              <input
                id="rating-input"
                type="number"
                min={1}
                max={10}
                value={ratingInput}
                onChange={(e) => setRatingInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitRatingFromInput();
                  }
                }}
              />
              <button onClick={submitRatingFromInput} disabled={!identity || room?.status !== "active"}>
                Submit vote
              </button>
            </div>
          </div>
        </div>

        <aside className="card stack room-presence-card">
          <div className="row spread center wrap gap">
            <h3>Players</h3>
            <span className="pill host">{presence.length} online · {currentRatings.length} voted</span>
          </div>

          <div className="player-list scroll-box">
            {playersView.length === 0 ? (
              <p className="empty-state">Waiting for players and votes.</p>
            ) : (
              playersView.map((member) => {
                const voted = member.voted;
                const memberRating = member.score;
                const isOffline = !member.isOnline;
                const roleLabel = member.isYou ? "You" : member.isHost ? "Host" : "Guest";

                return (
                  <div key={member.key} className={`player-row ${voted ? "voted" : "pending"} ${isOffline ? "inactive" : ""}`}>
                    <div>
                      <strong>
                        {member.displayName}
                        {voted && memberRating ? ` · ${memberRating}/10` : ""}
                      </strong>
                      <p>
                        {roleLabel}
                        {member.userCount > 1 ? ` · ${member.userCount} sessions` : ""}
                        {isOffline ? " · Offline" : " · Online"}
                      </p>
                    </div>
                    <span className={`vote-chip ${voted ? "voted" : isOffline ? "offline" : "pending"}`}>
                      {voted ? `Voted${memberRating ? ` · ${memberRating}/10` : ""}` : isOffline ? "Offline" : "Pending"}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          <div className="row spread center">
            <small className="muted">When everyone votes, the host can advance.</small>
            <button disabled={!isHost} onClick={goNextOpening}>
              {room.current_opening_index === openings.length - 1 ? "Finish session" : "Next opening"}
            </button>
          </div>
        </aside>

        <aside className="card queue-card">
          <h3>Queue</h3>
          <div className="scroll-box tall">
            {openings.map((opening, index) => {
              const values = (ratingsByOpening.get(opening.id) || []).map((r) => r.score);
              const avg = values.length
                ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)
                : "-";
              const isCurrent = index === room.current_opening_index;

              return (
                <div 
                  key={opening.id} 
                  className={`queue-item ${isCurrent ? "current" : ""} ${isHost ? "queue-item-clickable" : ""}`}
                  onClick={() => isHost && goToOpening(index)}
                  style={isHost ? { cursor: "pointer" } : {}}
                >
                  <img src={opening.thumbnail_url || ""} alt={opening.anime_title} className="queue-thumb" referrerPolicy="no-referrer" />
                  <div className="queue-meta">
                    <strong>{opening.anime_title}</strong>
                    <p>{opening.opening_label}</p>
                  </div>
                  <span className="queue-score">{avg}</span>
                </div>
              );
            })}
          </div>
        </aside>
      </section>
      </div>
    </main>
  );
}
