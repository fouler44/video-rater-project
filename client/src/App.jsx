import { lazy, Suspense, useEffect, useRef } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import LobbyPage from "./pages/LobbyPage";
import { prefersReducedMotion } from "./lib/viewTransition";

const RoomPage = lazy(() => import("./pages/RoomPage"));
const RankingsPage = lazy(() => import("./pages/RankingsPage"));
const CreateListPage = lazy(() => import("./pages/CreateListPage"));
const AuthPage = lazy(() => import("./pages/AuthPage"));

const ROOM_PAGE_PATTERN = /^\/room\/[^/]+$/;

const PAGE_MOTION_PRESETS = {
  default: {
    initial: { opacity: 0, y: 10, scale: 1 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: -10, scale: 1 },
    transition: { duration: 0.3 },
  },
  lobbyToRoom: {
    initial: { opacity: 0, y: 22, scale: 0.988 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: -14, scale: 1.004 },
    transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] },
  },
  roomToLobby: {
    initial: { opacity: 0, y: -14, scale: 0.994 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: 14, scale: 1.004 },
    transition: { duration: 0.38, ease: [0.22, 1, 0.36, 1] },
  },
  reduced: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: 0.18 },
  },
};

function isRoomPage(pathname) {
  return ROOM_PAGE_PATTERN.test(pathname);
}

function getTransitionKey(previousPath, nextPath) {
  if (previousPath === "/" && isRoomPage(nextPath)) return "lobbyToRoom";
  if (isRoomPage(previousPath) && nextPath === "/") return "roomToLobby";
  return "default";
}

function PageWrapper({ children, transitionKey }) {
  const motionPreset = prefersReducedMotion()
    ? PAGE_MOTION_PRESETS.reduced
    : PAGE_MOTION_PRESETS[transitionKey] || PAGE_MOTION_PRESETS.default;

  return (
    <motion.div
      initial={motionPreset.initial}
      animate={motionPreset.animate}
      exit={motionPreset.exit}
      transition={motionPreset.transition}
      className="min-h-[100dvh]"
    >
      {children}
    </motion.div>
  );
}

function RouteChunkFallback() {
  return <div className="min-h-[100dvh]" aria-hidden="true" />;
}

export default function App() {
  const location = useLocation();
  const previousPathRef = useRef(location.pathname);

  const transitionKey = getTransitionKey(previousPathRef.current, location.pathname);

  useEffect(() => {
    previousPathRef.current = location.pathname;
  }, [location.pathname]);

  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={<PageWrapper transitionKey={transitionKey}><LobbyPage /></PageWrapper>} />
        <Route path="/auth" element={<PageWrapper transitionKey={transitionKey}><Suspense fallback={<RouteChunkFallback />}><AuthPage /></Suspense></PageWrapper>} />
        <Route path="/create-list" element={<PageWrapper transitionKey={transitionKey}><Suspense fallback={<RouteChunkFallback />}><CreateListPage /></Suspense></PageWrapper>} />
        <Route path="/room/:roomId" element={<PageWrapper transitionKey={transitionKey}><Suspense fallback={<RouteChunkFallback />}><RoomPage /></Suspense></PageWrapper>} />
        <Route path="/room/:roomId/rankings" element={<PageWrapper transitionKey={transitionKey}><Suspense fallback={<RouteChunkFallback />}><RankingsPage /></Suspense></PageWrapper>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AnimatePresence>
  );
}
