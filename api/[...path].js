import app from "../server/src/index.js";

export default function handler(req, res) {
  return app(req, res);
}