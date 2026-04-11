import { motion } from "motion/react";

export default function LobbyHeroVisual({ prefersReducedMotion }) {
  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, y: 22, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.62, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
      className="hero-tilt-shell portal-sculpt-shell"
    >
      <div className="portal-sculpt-core" />
      <div className="portal-sculpt-orbit orbit-a" />
      <div className="portal-sculpt-orbit orbit-b" />
      <div className="portal-sculpt-orbit orbit-c" />

      <div className="portal-sculpt-bars" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>

      <div className="portal-sculpt-label">
        <p>Signal Bloom</p>
        <span>Reactive arena feed</span>
      </div>
    </motion.div>
  );
}
