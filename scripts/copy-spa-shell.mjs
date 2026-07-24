// Runs as `postbuild` (see package.json). TanStack Start in SPA mode prerenders
// a single shell to dist/client/_shell.html. Vercel serves `/` from index.html,
// and vercel.json rewrites every client-side route to /index.html, so we copy
// the shell to index.html after each build.
import { copyFileSync, existsSync } from "node:fs";

const dir = "dist/client";
const shell = `${dir}/_shell.html`;
const index = `${dir}/index.html`;

if (!existsSync(shell)) {
  console.error(`[spa-shell] Expected ${shell} to exist after build but it does not.`);
  process.exit(1);
}

copyFileSync(shell, index);
console.log(`[spa-shell] Copied ${shell} -> ${index}`);
