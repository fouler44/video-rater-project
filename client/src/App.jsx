import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import LobbyPage from "./pages/LobbyPage";
import RoomPage from "./pages/RoomPage";
import RankingsPage from "./pages/RankingsPage";
import CreateListPage from "./pages/CreateListPage";

function PageWrapper({ children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.3 }}
      className="min-h-screen"
    >
      {children}
    </motion.div>
  );
}

export default function App() {
  const location = useLocation();

  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={<PageWrapper><LobbyPage /></PageWrapper>} />
        <Route path="/create-list" element={<PageWrapper><CreateListPage /></PageWrapper>} />
        <Route path="/room/:roomId" element={<PageWrapper><RoomPage /></PageWrapper>} />
        <Route path="/room/:roomId/rankings" element={<PageWrapper><RankingsPage /></PageWrapper>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AnimatePresence>
  );
}
