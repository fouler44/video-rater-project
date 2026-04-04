import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiDelete, apiPost } from "../lib/api";
import { getDefaultAvatar, getIdentity } from "../lib/identity";
import { supabase } from "../lib/supabase";
import { 
  Users, 
  Play, 
  SkipForward, 
  Trophy, 
  Settings, 
  Star, 
  CheckCircle2,
  ChevronLeft, 
  RefreshCw 
} from "lucide-react";

const PARTYKIT_URL = import.meta.env.VITE_PARTYKIT_URL || "ws://localhost:1999";

function normalizeParticipantRow(row) {
  return {
    id: row.id || `${row.room_id || "room"}:${row.user_uuid}`,
    user_uuid: row.user_uuid,
    user_name: row.user_name || row.display_name || "Anon",
    avatar_url: row.avatar_url || getDefaultAvatar(row.user_name || row.display_name || "Anon"),
  };
}

export default function RoomPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const identity = getIdentity();

  const [room, setRoom] = useState(null);
  const [openings, setOpenings] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [myRating, setMyRating] = useState(0);
  const [isOwner, setIsOwner] = useState(false);
  const [currentOpeningVotes, setCurrentOpeningVotes] = useState([]);

  const currentOpening = useMemo(() => {
    if (!room || !openings.length) return null;
    return openings.find((o) => o.order_index === room.current_opening_index);
  }, [room, openings]);

  const participantByUuid = useMemo(
    () => Object.fromEntries(participants.map((item) => [item.user_uuid, item])),
    [participants],
  );

  const votedUserSet = useMemo(() => new Set(currentOpeningVotes.map((row) => row.user_uuid)), [currentOpeningVotes]);

  const userScoreMap = useMemo(
    () => Object.fromEntries(currentOpeningVotes.map((row) => [row.user_uuid, row.score])),
    [currentOpeningVotes],
  );

  const allParticipantsVoted = useMemo(
    () => participants.length > 0 && participants.every((p) => votedUserSet.has(p.user_uuid)),
    [participants, votedUserSet],
  );

  useEffect(() => {
    if (!identity) {
      navigate("/");
      return;
    }

    async function load() {
      setLoading(true);
      try {
        const { data: roomData, error: roomError } = await supabase
          .from("rooms")
          .select("*, lists(name)")
          .eq("id", roomId)
          .single();

        if (roomError) throw roomError;
        setRoom(roomData);
        setIsOwner(
          roomData.owner_user_id === identity.userId ||
          roomData.host_uuid === identity.userId ||
          identity.role === "admin",
        );

        const { data: openingsData, error: openingsError } = await supabase
          .from("list_openings")
          .select("*")
          .eq("list_id", roomData.list_id)
          .order("order_index", { ascending: true });

        if (openingsError) throw openingsError;
        setOpenings(openingsData || []);

        await upsertMyPresence();

        const { data: ratingData } = await supabase
          .from("ratings")
          .select("score")
          .eq("room_id", roomId)
          .eq("user_uuid", identity.userId)
          .eq("list_opening_id", openingsData.find((o) => o.order_index === roomData.current_opening_index)?.id)
          .maybeSingle();

        if (ratingData) setMyRating(ratingData.score);
      } catch (err) {
        alert(err.message);
        navigate("/");
      } finally {
        setLoading(false);
      }
    }

    load();

    const roomSub = supabase
      .channel(`room:${roomId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
        (payload) => {
          setRoom(payload.new);
          setMyRating(0);
        }
      )
      .subscribe();

    const participantSub = supabase
      .channel(`participants:${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_members", filter: `room_id=eq.${roomId}` },
        () => fetchParticipants()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_participants", filter: `room_id=eq.${roomId}` },
        () => fetchParticipants()
      )
      .subscribe();

    fetchParticipants();

    return () => {
      supabase.removeChannel(roomSub);
      supabase.removeChannel(participantSub);
    };
  }, [roomId]);

  useEffect(() => {
    async function fetchCurrentOpeningVotes() {
      if (!currentOpening?.id) {
        setCurrentOpeningVotes([]);
        return;
      }

      const { data, error } = await supabase
        .from("ratings")
        .select("user_uuid,score")
        .eq("room_id", roomId)
        .eq("list_opening_id", currentOpening.id);

      if (!error) {
        setCurrentOpeningVotes(data || []);
      }
    }

    fetchCurrentOpeningVotes();
  }, [roomId, currentOpening?.id]);

  useEffect(() => {
    setMyRating(0);
  }, [currentOpening?.id]);

  async function fetchParticipants() {
    const membersResult = await supabase
      .from("room_members")
      .select("room_id,user_uuid,display_name,avatar_url")
      .eq("room_id", roomId);

    if (!membersResult.error && membersResult.data) {
      setParticipants(membersResult.data.map(normalizeParticipantRow));
      return;
    }

    const legacyResult = await supabase
      .from("room_participants")
      .select("*")
      .eq("room_id", roomId);

    if (!legacyResult.error && legacyResult.data) {
      setParticipants(legacyResult.data.map(normalizeParticipantRow));
      return;
    }

    setParticipants([]);
  }

  function hasVoted(userUuid) {
    return votedUserSet.has(userUuid);
  }

  async function upsertMyPresence() {
    if (!identity) return;

    const payload = {
      room_id: roomId,
      user_uuid: identity.userId,
      user_id: identity.userId,
      display_name: identity.displayName,
      avatar_url: identity.avatarUrl || getDefaultAvatar(identity.displayName),
    };

    const { error } = await supabase.from("room_members").upsert(payload);
    if (!error) return;

    await supabase.from("room_participants").upsert({
      room_id: roomId,
      user_uuid: identity.userId,
      user_name: identity.displayName,
      avatar_url: identity.avatarUrl || getDefaultAvatar(identity.displayName),
    });
  }

  async function handleRate(score) {
    if (!currentOpening || !identity) return;
    setMyRating(score);
    await apiPost("/api/rooms/rate", {
      roomId,
      openingId: currentOpening.id,
      score,
    });
  }

  async function handleStartRoom() {
    if (!isOwner) return;
    setActionLoading(true);
    try {
      const data = await apiPost("/api/rooms/status", { roomId, status: "playing" });
      setRoom(data.room);
    } catch (err) {
      alert("Error starting session: " + (err.message || "Unknown error"));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleNext() {
    if (!isOwner || !room) return;
    if (room.current_opening_index >= openings.length - 1) {
      await apiPost("/api/rooms/status", { roomId, status: "finished" });
      navigate(`/rankings/${roomId}`);
    } else {
      await apiPost(`/api/rooms/${roomId}/advance`, {
        nextIndex: room.current_opening_index + 1,
      });
    }
  }

  async function handleSelectOpening(index) {
    if (!isOwner || !room) return;

    const safeIndex = Math.max(0, Math.min(openings.length - 1, Number(index)));
    setActionLoading(true);
    try {
      const data = await apiPost(`/api/rooms/${roomId}/opening`, {
        openingIndex: safeIndex,
      });
      setRoom(data.room);
    } catch (err) {
      alert("Error jumping to opening: " + (err.message || "Unknown error"));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDeleteRoom() {
    if (!isOwner) return;
    const confirmed = window.confirm("Delete this room? This action cannot be undone.");
    if (!confirmed) return;

    try {
      await apiDelete(`/api/rooms/${roomId}`);
      navigate("/");
    } catch (error) {
      alert(error.message || "Could not delete room");
    }
  }

  function goPrev() {
    if (!isOwner || !room || room.current_opening_index <= 0) return;
    handleSelectOpening(room.current_opening_index - 1);
  }

  if (loading) return <div className="flex items-center justify-center min-h-screen"><RefreshCw className="animate-spin text-brand-500" /></div>;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 h-[calc(100vh-2rem)] flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between mb-8 shrink-0">
        <div className="flex items-center gap-4">
          <Link to="/" className="p-2 hover:bg-slate-800 rounded-lg transition-colors">
            <ChevronLeft className="w-6 h-6" />
          </Link>
          <div>
            <h1 className="text-2xl font-black">{room?.name}</h1>
            <p className="text-xs text-slate-500 flex items-center gap-2 uppercase tracking-widest">
              <Star className="w-3 h-3 text-brand-400" />
              {room?.lists?.name}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-full text-xs font-bold text-slate-400">
            <Users className="w-3 h-3" />
            {participants.length} Active
          </div>
          {isOwner && (
            <button
              className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
              title="Delete room"
              onClick={handleDeleteRoom}
            >
              <Settings className="w-5 h-5" />
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 min-h-0">
        {/* Main Content: Video & Controls */}
        <div className="lg:col-span-8 flex flex-col gap-6 min-h-0">
          {room?.status === "playing" && currentOpening && (
            <div className="flex items-center justify-between px-4 py-2 bg-slate-900/40 border border-slate-800 rounded-2xl">
              <div>
                <h3 className="text-sm font-bold">{currentOpening.anime_title}</h3>
                <p className="text-[10px] text-slate-400 uppercase tracking-widest">{currentOpening.opening_label}</p>
              </div>
              <div className="bg-brand-500 px-3 py-1 rounded-full text-[10px] font-black shadow-lg">
                {room?.current_opening_index + 1} / {openings.length}
              </div>
            </div>
          )}
          <div className="relative aspect-video bg-black rounded-3xl overflow-hidden shadow-2xl border border-slate-800 group">
            {room?.status === "waiting" ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8">
                <div className="w-20 h-20 bg-brand-500/20 rounded-full flex items-center justify-center mb-6 animate-pulse">
                  <Play className="w-10 h-10 text-brand-400 fill-brand-400" />
                </div>
                <h2 className="text-3xl font-black mb-2">Waiting to Start</h2>
                <p className="text-slate-400 max-w-md mb-8">
                  The room owner will start the session once everyone has joined.
                </p>
                {isOwner && (
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
                <Link to={`/rankings/${roomId}`} className="btn-primary px-12 py-4 text-lg">
                  VIEW RANKINGS
                </Link>
              </div>
            ) : !currentOpening?.youtube_video_id ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8">
                <Play className="w-16 h-16 text-slate-600 mb-4" />
                <h2 className="text-2xl font-black mb-2">Video unavailable</h2>
                <p className="text-slate-400 max-w-md mb-6">
                  This opening does not have an embeddable YouTube video yet.
                </p>
                <a
                  className="btn-primary px-6 py-3"
                  href={`https://www.youtube.com/watch?v=${currentOpening?.youtube_video_id || ""}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open on YouTube
                </a>
              </div>
            ) : (
              <>
                <iframe
                  className="w-full h-full"
                  src={`https://www.youtube.com/embed/${currentOpening.youtube_video_id}?autoplay=1&controls=1&modestbranding=1&rel=0`}
                  title="YouTube video player"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                ></iframe>
              </>
            )}
          </div>

          {room?.status === "playing" && (
            <div className="card p-6 flex flex-col md:flex-row items-center justify-between gap-8">
              <div className="flex-1 text-center md:text-left">
                <h3 className="text-xs font-bold text-slate-500 uppercase tracking-[0.2em] mb-2">Rate this Opening</h3>
                <div className="flex items-center gap-2">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => (
                    <button
                      key={num}
                      onClick={() => handleRate(num)}
                      className={`w-8 h-10 md:w-10 md:h-12 rounded-xl font-black transition-all transform hover:scale-110 active:scale-95 ${
                        myRating === num
                          ? "bg-brand-500 text-white shadow-lg shadow-brand-500/40 -translate-y-1"
                          : "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                      }`}
                    >
                      {num}
                    </button>
                  ))}
                </div>
              </div>
              
              {isOwner && (
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <button
                    className="btn-secondary h-12 px-4 flex items-center gap-2"
                    onClick={goPrev}
                    disabled={room.current_opening_index <= 0}
                  >
                    Prev
                  </button>
                  <button 
                    className="btn-primary h-12 px-8 flex items-center gap-2"
                    onClick={handleNext}
                  >
                    <SkipForward className="w-4 h-4" />
                    {room.current_opening_index >= openings.length - 1 ? "Finish Session" : "Next Opening"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sidebar: People & Info */}
        <div className="lg:col-span-4 flex flex-col gap-6 min-h-0">
          <div className="card flex-1 flex flex-col min-h-0 p-0 overflow-hidden">
            <div className="flex-1 overflow-y-auto p-6 scrollbar-thin space-y-6">
              <div className="space-y-3">
                {participants.map((p) => (
                  <div key={p.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-900/50 border border-slate-800">
                    <div className="flex items-center gap-3 min-w-0">
                      <img
                        src={p.avatar_url || getDefaultAvatar(p.user_name)}
                        alt={p.user_name}
                        className="w-8 h-8 rounded-full object-cover border border-slate-700 shrink-0"
                        referrerPolicy="no-referrer"
                      />
                      <div className="min-w-0">
                        <span className="text-sm font-medium block truncate">{p.user_name}</span>
                        <div className="flex items-center gap-2 mt-1">
                          {(p.user_uuid === room?.owner_user_id || p.user_uuid === room?.host_uuid) && (
                            <span className="pill text-[8px] bg-amber-500/10 text-amber-500 border-amber-500/20">HOST</span>
                          )}
                          {hasVoted(p.user_uuid) ? (
                            allParticipantsVoted ? (
                              <span className="inline-flex items-center gap-1 text-xs font-bold text-brand-400">
                                {userScoreMap[p.user_uuid] || "—"}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[8px] font-bold uppercase tracking-widest text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-full px-2 py-1">
                                <CheckCircle2 className="w-3 h-3" />
                                Voted
                              </span>
                            )
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[8px] font-bold uppercase tracking-widest text-slate-400 bg-slate-700 rounded-full px-2 py-1 animate-pulse">
                              ⏳ Waiting
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-800 pt-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Queue</h3>
                  </div>
                  <span className="pill text-[8px]">{openings.length} items</span>
                </div>
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1 scrollbar-thin">
                  {openings.map((opening) => {
                    const isCurrent = opening.order_index === room?.current_opening_index;
                    const isPlayable = Boolean(opening.youtube_video_id);

                    return (
                      <button
                        key={opening.id}
                        type="button"
                        onClick={() => isOwner && handleSelectOpening(opening.order_index)}
                        disabled={!isOwner || actionLoading}
                        className={`w-full text-left rounded-xl border p-3 transition-all ${
                          isCurrent
                            ? "bg-brand-500/10 border-brand-500/40"
                            : "bg-slate-900/40 border-slate-800 hover:border-slate-700"
                        } ${isOwner && !actionLoading ? "hover:-translate-y-0.5" : ""} ${actionLoading ? "opacity-50 cursor-not-allowed" : ""}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center text-xs font-black shrink-0">
                            {opening.order_index + 1}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold truncate flex items-center gap-2">
                              {opening.anime_title}
                              {isCurrent && <CheckCircle2 className="w-4 h-4 text-brand-400 shrink-0" />}
                            </p>
                            <p className="text-[10px] text-slate-500 truncate">{opening.opening_label}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {opening.youtube_video_id ? (
                              <span className="text-[8px] uppercase tracking-widest text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-full px-2 py-1">
                                Video
                              </span>
                            ) : (
                              <span className="text-[8px] uppercase tracking-widest text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-full px-2 py-1">
                                No video
                              </span>
                            )}

                          </div>
                        </div>
                        {!isPlayable && (
                          <p className="text-[10px] text-slate-600 mt-2">This item has no embedded YouTube id yet.</p>
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
  );
}
