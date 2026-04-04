import { Navigate, Route, Routes } from "react-router-dom";
import LobbyPage from "./pages/LobbyPage";
import RoomPage from "./pages/RoomPage";
import RankingsPage from "./pages/RankingsPage";
import CreateListPage from "./pages/CreateListPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LobbyPage />} />
      <Route path="/create-list" element={<CreateListPage />} />
      <Route path="/room/:roomId" element={<RoomPage />} />
      <Route path="/room/:roomId/rankings" element={<RankingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
