import { useState } from "react";

export default function IdentityGate({ identity, onSave }) {
  const [displayName, setDisplayName] = useState(identity?.displayName || "");

  return (
    <div className="card stack">
      <div className="hero-copy">
        <span className="eyebrow">Identity</span>
        <h2>Welcome 👋</h2>
      </div>
      <p>Choose a name to join lobbies and sync in live rooms.</p>
      <input
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="Display name"
        maxLength={24}
      />
      <button
        className="btn-secondary"
        onClick={() => {
          const name = displayName.trim();
          if (!name) return;
          onSave(name);
        }}
      >
        Save name
      </button>
    </div>
  );
}
