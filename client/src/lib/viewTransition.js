export const UI_TRANSITIONS = Object.freeze({
  CREATE_ROOM_FLOW: "create-room-flow",
  ROOM_ROUTE_STAGE: "room-route-stage",
  QUICK_JOIN_STAGE: "quick-join-stage",
});

const ROOM_TRANSITION_DATASET_PROP = "openingsRoomTransitionName";

export function prefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function supportsViewTransitions() {
  return typeof document !== "undefined" && typeof document.startViewTransition === "function";
}

export function runViewTransition(update) {
  if (typeof update !== "function") return;

  if (!supportsViewTransitions() || prefersReducedMotion()) {
    update();
    return;
  }

  document.startViewTransition(() => {
    update();
  });
}

export function navigateWithTransition(navigate, to, options) {
  runViewTransition(() => {
    navigate(to, options);
  });
}

export function markPendingRoomTransition(name) {
  if (typeof document === "undefined") return;

  if (!name) {
    delete document.documentElement.dataset[ROOM_TRANSITION_DATASET_PROP];
    return;
  }

  document.documentElement.dataset[ROOM_TRANSITION_DATASET_PROP] = String(name);
}

export function readPendingRoomTransition() {
  if (typeof document === "undefined") return "";
  return String(document.documentElement.dataset[ROOM_TRANSITION_DATASET_PROP] || "");
}

export function clearPendingRoomTransition() {
  if (typeof document === "undefined") return;
  delete document.documentElement.dataset[ROOM_TRANSITION_DATASET_PROP];
}
