import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiPost } from "../lib/api";
import { getDefaultAvatar, getIdentity } from "../lib/identity";
import { supabase } from "../lib/supabase";
import { 
  Users, 
  Play, 
  Pause, 
  SkipForward, 
  Trophy, 
  Settings, 
  MessageSquare, 
  Send, 
  Star, 
  ChevronRight, 
  ChevronLeft, 
  Share2, 
  RefreshCw 
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

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
  const chatEndRef = useRef(null);

  const [room, setRoom] = useState(null);
  const [openings, setOpenings] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([]);
  const [currentMessage, setCurrentMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [myRating, setMyRating] = useState(0);
  const [isOwner, setIsOwner] = useState(false);
  const [activeTab, setActiveTab] = useState("chat");
  const [showRatings, setShowRatings] = useState(false);

  const currentOpening = useMemo(() => {
    if (!room || !openings.length) return null;
    return openings.find((o) => o.order_index === room.current_index);
  }, [room, openings]);

  const participantByUuid = useMemo(
    () => Object.fromEntries(participants.map((item) => [item.user_uuid, item])),
    [participants],
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
        setIsOwner(roomData.created_by === identity.uuid);

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
          .eq("user_uuid", identity.uuid)
          .eq("list_opening_id", openingsData.find(o => o.order_index === roomData.current_index)?.id)
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

    const chatSub = supabase
      .channel(`chat:${roomId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "room_messages", filter: `room_id=eq.${roomId}` },
        (payload) => {
          setMessages((prev) => [...prev, payload.new]);
        }
      )
      .subscribe();

    fetchParticipants();
    fetchMessages();

    return () => {
      supabase.removeChannel(roomSub);
      supabase.removeChannel(participantSub);
      supabase.removeChannel(chatSub);
    };
  }, [roomId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

  async function upsertMyPresence() {
    if (!identity) return;

    const payload = {
      room_id: roomId,
      user_uuid: identity.uuid,
      display_name: identity.displayName,
      avatar_url: identity.avatarUrl || getDefaultAvatar(identity.displayName),
    };

    const { error } = await supabase.from("room_members").upsert(payload);
    if (!error) return;

    await supabase.from("room_participants").upsert({
      room_id: roomId,
      user_uuid: identity.uuid,
      user_name: identity.displayName,
      avatar_url: identity.avatarUrl || getDefaultAvatar(identity.displayName),
    });
  }

  async function fetchMessages() {
    const { data } = await supabase
      .from("room_messages")
      .select("*")
      .eq("room_id", roomId)
      .order("created_at", { ascending: true });
    setMessages(data || []);
  }

  async function handleSendMessage() {
    if (!currentMessage.trim() || !identity) return;
    const msg = currentMessage.trim();
    setCurrentMessage("");

    await supabase.from("room_messages").insert({
      room_id: roomId,
      user_uuid: identity.uuid,
      user_name: identity.displayName,
      content: msg,
    });
  }

  async function handleRate(score) {
    if (!currentOpening || !identity) return;
    setMyRating(score);
    await apiPost("/api/rooms/rate", {
      roomId,
      userUuid: identity.uuid,
      openingId: currentOpening.id,
      score,
    });
  }

  async function handleStartRoom() {
    if (!isOwner) return;
    await apiPost("/api/rooms/status", { roomId, status: "playing" });
  }

  async function handleNext() {
    if (!isOwner || !room) return;
    if (room.current_index >= openings.length - 1) {
      await apiPost("/api/rooms/status", { roomId, status: "finished" });
      navigate(`/rankings/${roomId}`);
    } else {
      await apiPost("/api/rooms/next", { roomId });
    }
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
          <button className="p-2 hover:bg-slate-800 rounded-lg transition-colors">
            <Share2 className="w-5 h-5" />
          </button>
          {isOwner && (
            <button className="p-2 hover:bg-slate-800 rounded-lg transition-colors">
              <Settings className="w-5 h-5" />
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 min-h-0">
        {/* Main Content: Video & Controls */}
        <div className="lg:col-span-8 flex flex-col gap-6 min-h-0">
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
                  <button className="btn-primary px-12 py-4 text-lg" onClick={handleStartRoom}>
                    START SESSION
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
            ) : (
              <>
                <iframe
                  className="w-full h-full"
                  src={`https://www.youtube.com/embed/${currentOpening?.youtube_video_id}?autoplay=1&controls=1&modestbranding=1&rel=0`}
                  title="YouTube video player"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                ></iframe>
                <div className="absolute top-6 left-6 right-6 flex items-start justify-between pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="bg-black/60 backdrop-blur-md px-4 py-2 rounded-xl border border-white/10">
                    <h3 className="text-sm font-bold">{currentOpening?.anime_title}</h3>
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest">{currentOpening?.opening_label}</p>
                  </div>
                  <div className="bg-brand-500 px-3 py-1 rounded-full text-[10px] font-black shadow-lg">
                    {room?.current_index + 1} / {openings.length}
                  </div>
                </div>
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
                <button 
                  className="btn-primary h-12 px-8 flex items-center gap-2 whitespace-nowrap"
                  onClick={handleNext}
                >
                  <SkipForward className="w-4 h-4" />
                  {room.current_index >= openings.length - 1 ? "Finish Session" : "Next Opening"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Sidebar: Chat & Info */}
        <div className="lg:col-span-4 flex flex-col gap-6 min-h-0">
          <div className="card flex-1 flex flex-col min-h-0 p-0 overflow-hidden">
            <div className="flex border-b border-slate-800">
              <button 
                className={`flex-1 py-4 text-xs font-bold uppercase tracking-widest transition-colors ${activeTab === 'chat' ? 'text-brand-400 border-b-2 border-brand-500' : 'text-slate-500 hover:text-slate-300'}`}
                onClick={() => setActiveTab('chat')}
              >
                Chat
              </button>
              <button 
                className={`flex-1 py-4 text-xs font-bold uppercase tracking-widest transition-colors ${activeTab === 'participants' ? 'text-brand-400 border-b-2 border-brand-500' : 'text-slate-500 hover:text-slate-300'}`}
                onClick={() => setActiveTab('participants')}
              >
                People ({participants.length})
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
              {activeTab === 'chat' ? (
                <div className="space-y-4">
                  {messages.map((msg, idx) => (
                    <div key={msg.id || idx} className={`flex flex-col ${msg.user_uuid === identity?.uuid ? 'items-end' : 'items-start'}`}>
                      <div className="flex items-center gap-2 mb-1">
                        <img
                          src={
                            participantByUuid[msg.user_uuid]?.avatar_url ||
                            (msg.user_uuid === identity?.uuid ? identity?.avatarUrl : "") ||
                            getDefaultAvatar(msg.user_name)
                          }
                          alt={msg.user_name}
                          className="w-5 h-5 rounded-full object-cover border border-slate-700"
                          referrerPolicy="no-referrer"
                        />
                        <span className="text-[10px] font-bold text-slate-500">{msg.user_name}</span>
                        <span className="text-[8px] text-slate-700">{new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <div className={`px-4 py-2 rounded-2xl text-sm max-w-[85%] ${
                        msg.user_uuid === identity?.uuid 
                          ? 'bg-brand-600 text-white rounded-tr-none' 
                          : 'bg-slate-800 text-slate-200 rounded-tl-none'
                      }`}>
                        {msg.content}
                      </div>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
              ) : (
                <div className="space-y-3">
                  {participants.map((p) => (
                    <div key={p.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-900/50 border border-slate-800">
                      <div className="flex items-center gap-3">
                        <img
                          src={p.avatar_url || getDefaultAvatar(p.user_name)}
                          alt={p.user_name}
                          className="w-8 h-8 rounded-full object-cover border border-slate-700"
                          referrerPolicy="no-referrer"
                        />
                        <span className="text-sm font-medium">{p.user_name}</span>
                      </div>
                      {p.user_uuid === room?.created_by && (
                        <span className="pill text-[8px] bg-amber-500/10 text-amber-500 border-amber-500/20">HOST</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {activeTab === 'chat' && (
              <div className="p-4 bg-slate-900/50 border-t border-slate-800">
                <div className="relative">
                  <input
                    value={currentMessage}
                    onChange={(e) => setCurrentMessage(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
                    placeholder="Type a message..."
                    className="w-full pr-12 h-12"
                  />
                  <button 
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-brand-400 hover:text-brand-300 transition-colors"
                    onClick={handleSendMessage}
                  >
                    <Send className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="card p-6 bg-brand-500/5 border-brand-500/10">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Up Next</h3>
            <div className="space-y-3">
              {openings.slice(room?.current_index + 1, room?.current_index + 4).map((op, idx) => (
                <div key={op.id} className="flex items-center gap-3 opacity-60">
                  <div className="w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center text-xs font-bold">
                    {room.current_index + idx + 2}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-bold truncate">{op.anime_title}</p>
                    <p className="text-[10px] text-slate-600">{op.opening_label}</p>
                  </div>
                </div>
              ))}
              {openings.length - room?.current_index - 1 > 3 && (
                <p className="text-[10px] text-slate-700 text-center pt-2">
                  + {openings.length - room?.current_index - 4} more openings
                </p>
              )}
              {room?.current_index >= openings.length - 1 && (
                <p className="text-xs text-slate-500 italic text-center">No more openings</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
