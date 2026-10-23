import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };
// Tauri expects a fixed port and does not need the screen output of Vite.
export default defineConfig({
	plugins: [react()],
	clearScreen: false,
	// The version shows in the window title (for bug reports).
	define: { __APP_VERSION__: JSON.stringify(pkg.version) },
	server: { port: 1420, strictPort: true },
	build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
