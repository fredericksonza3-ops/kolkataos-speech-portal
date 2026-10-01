import http from "node:http";
import { handle } from "../lib/portal.js";

const port = Number(process.env.PORT || 8787);

http.createServer((req, res) => handle(req, res).catch((error) => {
  res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: error.message || "server error" }));
})).listen(port, () => {
  console.log(`Speech Portal listening on http://localhost:${port}`);
});
