import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;

          if (id.includes("react-router-dom")) return "vendor-router";
          if (id.includes("lucide-react")) return "vendor-icons";
          if (id.includes("motion")) return "vendor-motion";
          if (id.includes("@supabase/supabase-js")) return "vendor-supabase";
          if (id.includes("react") || id.includes("scheduler")) return "vendor-react";

          return "vendor-misc";
        },
      },
    },
  },
});
