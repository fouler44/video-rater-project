import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getIdentity } from "../lib/identity";
import { supabase } from "../lib/supabase";

export default function RankingsPage() {
  const { roomId } = useParams();
  const identity = getIdentity();

  const [room, setRoom] = useState(null);
  const [openings, setOpenings] = useState([]);
  const [ratings, setRatings] = useState([]);
  const [storedRankings, setStoredRankings] = useState([]);

  useEffect(() => {
    async function load() {
      const { data: roomData, error: roomError } = await supabase
        .from("rooms")
        .select("id,name,list_id,status")
        .eq("id", roomId)
        .single();

      if (roomError) {
        alert(roomError.message);
        return;
      }

      const { data: openingsData, error: openingsError } = await supabase
        .from("list_openings")
        .select("id,anime_title,opening_label,thumbnail_url,order_index")
        .eq("list_id", roomData.list_id)
        .order("order_index", { ascending: true });

      if (openingsError) {
        alert(openingsError.message);
        return;
      }

      const { data: ratingsData, error: ratingsError } = await supabase
        .from("ratings")
        .select("list_opening_id,user_uuid,score")
        .eq("room_id", roomId);

      if (ratingsError) {
        alert(ratingsError.message);
        return;
      }

      const { data: rankingsData } = await supabase
        .from("room_rankings")
        .select("list_opening_id,ranking_type,user_uuid,score")
        .eq("room_id", roomId);

      setRoom(roomData);
      setOpenings(openingsData || []);
      setRatings(ratingsData || []);
      setStoredRankings(rankingsData || []);
    }

    load();
  }, [roomId]);

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
              item.user_uuid === identity?.uuid
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
        const myScore = scoped.find((item) => item.user_uuid === identity?.uuid)?.score ?? null;
        return {
          ...opening,
          groupAvg,
          myScore,
        };
      })
      .sort((a, b) => b.groupAvg - a.groupAvg);
  }, [openings, ratings, storedRankings, identity?.uuid]);

  return (
    <main className="results-page">
      <div className="results-shell">
        <header className="section-head">
          <div className="hero-copy">
            <span className="eyebrow">Results</span>
            <h1>{room?.name || "Results"}</h1>
            <p>Final group ranking and your personal scores.</p>
          </div>
          <div className="row gap">
            <span className="code-chip mono">{roomId.slice(0, 8).toUpperCase()}</span>
            <Link className="button-link btn-ghost" to={`/room/${roomId}`}>Back to room</Link>
            <Link className="button-link btn-secondary" to="/">Lobby</Link>
          </div>
        </header>

        <section className="results-grid">
          <div className="card stack">
            <h3>Group Ranking</h3>
            {ranking.map((item, index) => (
              <div key={item.id} className="rank-row result-row">
                <div className="row gap center">
                  <span className="rank-pill">#{index + 1}</span>
                  {item.thumbnail_url ? <img src={item.thumbnail_url} alt={item.anime_title} className="thumb" /> : null}
                  <div>
                    <strong>{item.anime_title}</strong>
                    <p>{item.opening_label}</p>
                  </div>
                </div>
                <span className="result-score">{item.groupAvg.toFixed(2)}</span>
              </div>
            ))}
          </div>

          <div className="card stack">
            <h3>Your Ranking</h3>
            {ranking.map((item, index) => (
              <div key={`${item.id}-you`} className="rank-row result-row muted-row">
                <div className="row gap center">
                  <span className="rank-pill">#{index + 1}</span>
                  {item.thumbnail_url ? <img src={item.thumbnail_url} alt={item.anime_title} className="thumb" /> : null}
                  <div>
                    <strong>{item.anime_title}</strong>
                    <p>{item.opening_label}</p>
                  </div>
                </div>
                <span className="result-score personal">{item.myScore ?? "-"}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
