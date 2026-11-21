import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server is not started by `vite` directly: server/main.ts runs Vite in
// middleware mode next to the WebSocket bridge, so everything shares one port.
export default defineConfig({
  plugins: [react()],
});
