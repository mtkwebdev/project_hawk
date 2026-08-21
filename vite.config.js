import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// If deploying to GitHub Pages at https://<user>.github.io/<repo>/,
// set base to "/<repo>/". "./" (relative) works for most other hosts
// (Vercel, Netlify, a custom domain, or GitHub Pages on a user/org site).
export default defineConfig({
  plugins: [react()],
  base: "./",
});
