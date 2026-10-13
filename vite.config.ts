import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = `http://127.0.0.1:${process.env.OCTAVE_PORT ?? 7420}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/ws": { target: api, ws: true },
    },
  },
});
