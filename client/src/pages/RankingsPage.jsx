import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getIdentity } from "../lib/identity";
import { supabase } from "../lib/supabase";
import { 
  Trophy, 
  Home, 
  ArrowLeft, 
  Users, 
  User, 
  Medal, 
  Star, 
  RefreshCw,
  Layout,
  Music,
  AlertTriangle,
  X
} from "lucide-react";
import { motion } from "motion/react";

export default function RankingsPage() {
  const { roomId } = useParams();
  const identity = getIdentity();

  const [room, setRoom] = useState(null);
  const [openings, setOpenings] = useState([]);
  const [ratings, setRatings] = useState([]);
  const [storedRankings, setStoredRankings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uiNotice, setUiNotice] = useState(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const { data: roomData, error: roomError } = await supabase
          .from("rooms")
          .select("id,name,list_id,status")
          .eq("id", roomId)
          .single();

        if (roomError) throw roomError;

        const { data: openingsData, error: openingsError } = await supabase
          .from("list_openings")
          .select("id,anime_title,opening_label,thumbnail_url,order_index")
          .eq("list_id", roomData.list_id)
          .order("order_index", { ascending: true });

        if (openingsError) throw openingsError;

        const { data: ratingsData, error: ratingsError } = await supabase
          .from("ratings")
          .select("list_opening_id,user_uuid,score")
          .eq("room_id", roomId);

        if (ratingsError) throw ratingsError;

        const { data: rankingsData } = await supabase
          .from("room_rankings")
          .select("list_opening_id,ranking_type,user_uuid,score")
          .eq("room_id", roomId);

        setRoom(roomData);
        setOpenings(openingsData || []);
        setRatings(ratingsData || []);
        setStoredRankings(rankingsData || []);
      } catch (err) {
        showNotice(err.message || "Could not load rankings");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [roomId]);

  useEffect(() => {
    if (!uiNotice) return;

    const timeout = window.setTimeout(() => {
      setUiNotice(null);
    }, 4000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [uiNotice]);

  function showNotice(message) {
    setUiNotice({ message: String(message || "Unexpected error") });
  }

  const ranking = useMemo(() => {
    const hasStored = storedRankings.length > 0;

    if (hasStored) {
      return openings
        .map((opening) => {
          const group = storedRankings.find(
            (item) => item.list_opening_id === opening.id && item.ranking_type === "group"
          );

          const me = storedRankings.find(
            (item) =>
              item.list_opening_id === opening.id &&
              item.ranking_type === "personal" &&
              item.user_uuid === identity?.userId
          );

          return {
            ...opening,
            groupAvg: Number(group?.score || 0),
            myScore: me?.score ?? null,
          };
        })
        .sort((a, b) => b.groupAvg - a.groupAvg);
    }

    return openings
      .map((opening) => {
        const scoped = ratings.filter((r) => r.list_opening_id === opening.id);
        const groupAvg = scoped.length
          ? scoped.reduce((sum, item) => sum + item.score, 0) / scoped.length
          : 0;
        const myScore = scoped.find((item) => item.user_uuid === identity?.userId)?.score ?? null;
        return {
          ...opening,
          groupAvg,
          myScore,
        };
      })
      .sort((a, b) => b.groupAvg - a.groupAvg);
  }, [openings, ratings, storedRankings, identity?.userId]);

  if (loading) return <div className="flex items-center justify-center min-h-screen"><RefreshCw className="animate-spin text-brand-500" /></div>;

  return (
    <div className="max-w-6xl mx-auto px-4 py-12">
      {uiNotice ? (
        <div
          className="mb-4 text-sm px-4 py-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-100 flex items-start gap-3 animate-fade-in"
          role="alert"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
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
          <Link to={`/room/${roomId}`} className="p-2 hover:bg-slate-800 rounded-lg transition-colors">
            <ArrowLeft className="w-6 h-6" />
          </Link>
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-3">
              <Trophy className="w-8 h-8 text-yellow-500" />
              {room?.name} Rankings
            </h1>
            <p className="text-slate-400">Final results and personal scores.</p>
          </div>
        </div>
        <div className="flex gap-3">
          <Link className="btn-secondary flex items-center gap-2" to="/">
            <Home className="w-4 h-4" />
            Lobby
          </Link>
          <Link className="btn-primary flex items-center gap-2" to={`/room/${roomId}`}>
            <Layout className="w-4 h-4" />
            Back to Room
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Group Ranking */}
        <section className="space-y-6">
          <div className="flex items-center gap-2 mb-2">
            <Users className="w-5 h-5 text-brand-400" />
            <h3 className="text-xl font-bold">Group Consensus</h3>
          </div>
          
          <div className="space-y-4">
            {ranking.map((item, index) => (
              <motion.div 
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
                key={item.id} 
                className={`card flex items-center gap-4 p-4 relative overflow-hidden group ${index === 0 ? 'border-yellow-500/50 bg-yellow-500/5' : ''}`}
              >
                {index === 0 && (
                  <div className="absolute top-0 right-0 p-2">
                    <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                  </div>
                )}
                
                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-slate-800 text-lg font-black shrink-0">
                  {index + 1}
                </div>

                <div className="relative w-16 h-16 shrink-0">
                  <img 
                    src={item.thumbnail_url || ""} 
                    alt="" 
                    className="w-full h-full object-cover rounded-xl shadow-lg"
                    referrerPolicy="no-referrer"
                  />
                  {index < 3 && (
                    <div className="absolute -top-2 -right-2">
                      <Medal className={`w-6 h-6 ${index === 0 ? 'text-yellow-500' : index === 1 ? 'text-slate-400' : 'text-amber-700'}`} />
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <h4 className="font-bold truncate group-hover:text-brand-400 transition-colors">{item.anime_title}</h4>
                  <p className="text-xs text-slate-500 flex items-center gap-1">
                    <Music className="w-3 h-3" />
                    {item.opening_label}
                  </p>
                </div>

                <div className="text-right">
                  <div className="text-2xl font-black text-brand-400">{item.groupAvg.toFixed(1)}</div>
                  <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Avg Score</div>
                </div>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Personal Ranking */}
        <section className="space-y-6">
          <div className="flex items-center gap-2 mb-2">
            <User className="w-5 h-5 text-brand-400" />
            <h3 className="text-xl font-bold">Your Personal Scores</h3>
          </div>

          <div className="space-y-4">
            {ranking.map((item, index) => (
              <motion.div 
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.05 }}
                key={`${item.id}-you`} 
                className="card flex items-center gap-4 p-4 bg-slate-900/30 border-slate-800/50 opacity-80 hover:opacity-100 transition-opacity"
              >
                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-slate-900 border border-slate-800 text-sm font-bold text-slate-500 shrink-0">
                  {index + 1}
                </div>

                <div className="w-12 h-12 shrink-0">
                  <img 
                    src={item.thumbnail_url || ""} 
                    alt="" 
                    className="w-full h-full object-cover rounded-lg grayscale opacity-50"
                    referrerPolicy="no-referrer"
                  />
                </div>

                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-bold truncate text-slate-300">{item.anime_title}</h4>
                  <p className="text-[10px] text-slate-500">{item.opening_label}</p>
                </div>

                <div className="text-right">
                  <div className={`text-xl font-black ${item.myScore ? 'text-brand-400' : 'text-slate-700'}`}>
                    {item.myScore ?? "-"}
                  </div>
                  <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Your Score</div>
                </div>
              </motion.div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}