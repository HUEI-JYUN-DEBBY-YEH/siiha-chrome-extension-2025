// scripts/bundle.mjs
// Minimal esbuild bundle for MV3 extension/UI packages
// - Drops console.*
// - No sourcemap
// - Content-hash filenames for dist assets
// - Optional profile define: EXT vs UI

import esbuild from "esbuild";
import path from "node:path";
import fs from "node:fs";

const PROFILE = process.env.PROFILE || "ext";
const OUTDIR = "dist-bundle";

fs.rmSync(OUTDIR, { recursive: true, force: true });

/**
 * Simple plugin to drop console.* calls
 */
const dropConsole = {
  name: "drop-console",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, "utf8");
      const replaced = source.replace(/\bconsole\.[a-zA-Z]+\s*\([^;]*\);?/g, "");
      return { contents: replaced, loader: args.path.endsWith(".ts") ? "ts" : "js" };
    });
  }
};

await esbuild.build({
  entryPoints: {
    "background": "src/background.js",
    "content": "src/content.js",
    "options": "src/options.js"
  },
  outdir: OUTDIR,
  format: "esm",
  bundle: true,
  splitting: true,
  minify: true,
  sourcemap: false,
  define: {
    "__PROFILE__": JSON.stringify(PROFILE)
  },
  plugins: [dropConsole]
});

console.log(`[bundle] profile=${PROFILE} → ${OUTDIR}`);
