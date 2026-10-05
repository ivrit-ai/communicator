// Other ivrit.ai apps (the ivrit.ai app at app.ivrit.ai) use this server's
// API from their own origin: the same accounts, devices and sources, without
// Communicator's pages. They are on the same site (*.ivrit.ai), so the session
// cookie travels with their requests; CORS only has to let the browser hand
// them the responses.
//
// Read lazily-tolerant, like EXPECTED_HOSTS: unset means no other origins.
export const APP_ORIGINS = new Set(
  (process.env.APP_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, "").toLowerCase())
    .filter(Boolean)
);

export function allowedAppOrigin(origin) {
  return Boolean(origin) && APP_ORIGINS.has(String(origin).toLowerCase());
}

export function cors(req, res, next) {
  const origin = req.get("origin");
  if (!allowedAppOrigin(origin)) return next();
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.append("Vary", "Origin");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Max-Age", "600");
    return res.status(204).end();
  }
  next();
}
