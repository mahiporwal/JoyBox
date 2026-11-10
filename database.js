"use strict";

const { createHash } = require("node:crypto");

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function createPostgresStore(connectionString) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_SIZE) || 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined
  });

  return {
    async initialize() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS joybox_users (
          email TEXT PRIMARY KEY,
          name VARCHAR(40) NOT NULL,
          salt CHAR(32) NOT NULL,
          password_hash CHAR(128) NOT NULL,
          favorites JSONB NOT NULL DEFAULT '[]'::jsonb,
          email_verified BOOLEAN NOT NULL DEFAULT FALSE,
          verification_token_hash CHAR(64),
          verification_expires_at TIMESTAMPTZ,
          reset_token_hash CHAR(64),
          reset_expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE joybox_users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE joybox_users ADD COLUMN IF NOT EXISTS verification_token_hash CHAR(64);
        ALTER TABLE joybox_users ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ;
        ALTER TABLE joybox_users ADD COLUMN IF NOT EXISTS reset_token_hash CHAR(64);
        ALTER TABLE joybox_users ADD COLUMN IF NOT EXISTS reset_expires_at TIMESTAMPTZ;
        CREATE TABLE IF NOT EXISTS joybox_sessions (
          token_hash CHAR(64) PRIMARY KEY,
          email TEXT NOT NULL REFERENCES joybox_users(email) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS joybox_sessions_expiry_idx ON joybox_sessions(expires_at);
      `);
    },
    async healthCheck() {
      await pool.query("SELECT 1");
    },
    async getUser(email) {
      const result = await pool.query(
        `SELECT email, name, salt, password_hash AS "passwordHash", favorites,
                email_verified AS "emailVerified"
         FROM joybox_users WHERE email = $1`,
        [email]
      );
      return result.rows[0] || null;
    },
    async createUser(user) {
      try {
        await pool.query(
          "INSERT INTO joybox_users (email, name, salt, password_hash, email_verified) VALUES ($1, $2, $3, $4, FALSE)",
          [user.email, user.name, user.salt, user.passwordHash]
        );
      } catch (error) {
        if (error.code === "23505") return false;
        throw error;
      }
      return true;
    },
    async createSession(token, email, expiresAt) {
      const tokenHash = hashToken(token);
      await pool.query(
        "INSERT INTO joybox_sessions (token_hash, email, expires_at) VALUES ($1, $2, $3)",
        [tokenHash, email, new Date(expiresAt)]
      );
      await pool.query("DELETE FROM joybox_sessions WHERE expires_at <= NOW()");
    },
    async getSessionUser(token) {
      const result = await pool.query(
        `SELECT u.email, u.name, u.favorites
         FROM joybox_sessions s
         JOIN joybox_users u ON u.email = s.email
         WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
        [hashToken(token)]
      );
      return result.rows[0] || null;
    },
    async deleteSession(token) {
      await pool.query("DELETE FROM joybox_sessions WHERE token_hash = $1", [hashToken(token)]);
    },
    async updateFavorites(email, favorites) {
      const result = await pool.query(
        "UPDATE joybox_users SET favorites = $2::jsonb WHERE email = $1 RETURNING favorites",
        [email, JSON.stringify(favorites)]
      );
      return result.rows[0]?.favorites || null;
    },
    async setVerificationToken(email, tokenHash, expiresAt) {
      await pool.query(
        "UPDATE joybox_users SET verification_token_hash = $2, verification_expires_at = $3 WHERE email = $1 AND email_verified = FALSE",
        [email, tokenHash, new Date(expiresAt)]
      );
    },
    async verifyEmail(tokenHash) {
      const result = await pool.query(
        `UPDATE joybox_users SET email_verified = TRUE,
           verification_token_hash = NULL, verification_expires_at = NULL
         WHERE verification_token_hash = $1 AND verification_expires_at > NOW()
         RETURNING email`,
        [tokenHash]
      );
      return result.rows[0]?.email || null;
    },
    async setPasswordResetToken(email, tokenHash, expiresAt) {
      await pool.query(
        "UPDATE joybox_users SET reset_token_hash = $2, reset_expires_at = $3 WHERE email = $1",
        [email, tokenHash, new Date(expiresAt)]
      );
    },
    async resetPassword(tokenHash, salt, passwordHash) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `UPDATE joybox_users SET salt = $2, password_hash = $3,
             reset_token_hash = NULL, reset_expires_at = NULL
           WHERE reset_token_hash = $1 AND reset_expires_at > NOW()
           RETURNING email`,
          [tokenHash, salt, passwordHash]
        );
        const email = result.rows[0]?.email || null;
        if (email) await client.query("DELETE FROM joybox_sessions WHERE email = $1", [email]);
        await client.query("COMMIT");
        return Boolean(email);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    }
  };
}

module.exports = { createPostgresStore };
