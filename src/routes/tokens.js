import { Router } from "express";
import { evictToken, generateToken } from "../auth-token.js";
import { requireSameOrigin, requireSession } from "../auth-session.js";

const MAX_NAME = 64;
const MAX_TOKENS = 50;

export function tokenRoutes(pool) {
  const router = Router();
  router.use("/api/tokens", requireSession(pool));

  router.get("/api/tokens", async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT token_id, name, created_at, last_used_at
           FROM ingest_tokens
          WHERE user_sub = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC`,
        [req.user.sub]
      );
      res.json({ tokens: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/tokens", requireSameOrigin, async (req, res, next) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ error: "name_required" });
    if (Buffer.byteLength(name) > MAX_NAME) {
      return res.status(400).json({ error: "name_too_long", limit: MAX_NAME });
    }

    try {
      const { rows: countRows } = await pool.query(
        "SELECT count(*)::int AS n FROM ingest_tokens WHERE user_sub = $1 AND revoked_at IS NULL",
        [req.user.sub]
      );
      if (countRows[0].n >= MAX_TOKENS) {
        return res.status(409).json({ error: "too_many_tokens", limit: MAX_TOKENS });
      }

      const { tokenId, secretHash, wire } = generateToken();
      await pool.query(
        `INSERT INTO ingest_tokens (token_id, secret_hash, user_sub, name)
         VALUES ($1, $2, $3, $4)`,
        [tokenId, secretHash, req.user.sub, name]
      );

      // The only time the raw token ever leaves the server. Nothing persists it.
      res.status(201).json({ token_id: tokenId, name, token: wire });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/api/tokens/:tokenId", requireSameOrigin, async (req, res, next) => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE ingest_tokens SET revoked_at = now()
          WHERE token_id = $1 AND user_sub = $2 AND revoked_at IS NULL`,
        [req.params.tokenId, req.user.sub]
      );
      if (!rowCount) return res.status(404).json({ error: "not_found" });
      // Revocation has to reach the in-process cache immediately, or the token
      // keeps working for up to the cache TTL after the user revoked it.
      evictToken(req.params.tokenId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
