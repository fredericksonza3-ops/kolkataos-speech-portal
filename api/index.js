import { handle } from "../server.js";

export default function api(req, res) {
  return handle(req, res).catch((error) => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: error.message || "server error" }));
  });
}
