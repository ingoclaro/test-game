/**
 * Build script for the P2P PoC.
 *  - `bun run build.ts`          → production build into ./dist
 *  - `bun run build.ts --serve`  → local dev server with hot reload
 */
const serve = process.argv.includes("--serve");

export {};

if (serve) {
  const index = (await import("./src/index.html")).default;
  const server = Bun.serve({
    port: 3000,
    development: true,
    routes: {
      "/": index,
      "/index.html": index,
    },
  });
  console.log(`Dev server running at ${server.url}`);
} else {
  const result = await Bun.build({
    entrypoints: ["src/index.html"],
    outdir: "dist",
    minify: true,
    // Relative asset paths so the site works from the /test-game/ GH Pages subpath.
    publicPath: "./",
    naming: {
      asset: "[name]-[hash].[ext]",
    },
  });

  if (!result.success) {
    console.error("Build failed");
    for (const message of result.logs) console.error(message);
    process.exit(1);
  }
  console.log(`Build complete: ${result.outputs.length} files written to ./dist`);
}
