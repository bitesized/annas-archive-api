/**
 * Local server. Serves `public/` statically with express and mounts each file
 * in `api/` as a route handler. The handlers are framework-agnostic
 * (req.query / res.status().json()), so they stay small and easy to test.
 */

import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import searchHandler from "./api/search.js";
import downloadHandler from "./api/download.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.get("/api/search", searchHandler);
app.get("/api/download", downloadHandler);
app.use(express.static(join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () =>
  console.log(`Book Search running at http://localhost:${PORT}`)
);

// Without this, an already-in-use port lets the listen callback fire and then
// emits EADDRINUSE on the server; with no handler the process exits silently
// (code 0), which looks like "the app closes straight after running".
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. ` +
        `Set PORT to a free port, e.g. \`PORT=4020 npm run dev\`.`
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
