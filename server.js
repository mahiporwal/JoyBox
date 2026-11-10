"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { promisify } = require("node:util");
const { createHash, randomBytes, scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");
const { createPostgresStore } = require("./database");

const scrypt = promisify(scryptCallback);
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const COOKIE_NAME = "joybox_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const DATA_DIR = process.env.JOYBOX_DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "accounts.json");
const GAME_TITLES = new Set([
  "Star Catcher", "Jungle Dash", "Tiny Towers", "Turbo Paws", "Bubble Pop",
  "Goal Getters", "Moon Miner", "Color Cubes", "Pizza Panic", "Snowboard Spin",
  "Ocean Quest", "Rocket Rally"
]);
const fileSessions = new Map();
const authAttempts = new Map();

function readDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) return { users: {} };

  const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!parsed || typeof parsed.users !== "object" || Array.isArray(parsed.users)) {
    throw new Error("The accounts database has an invalid format.");
  }
  return parsed;
}

function writeDatabase(database) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(database, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, DATA_FILE);
}

function createFileStore() {
  return {
    async initialize() {},
    async healthCheck() {},
    async getUser(email) {
      const database = readDatabase();
      const user = database.users[email];
      return user ? { email, ...user, passwordHash: user.passwordHash } : null;
    },
    async createUser(user) {
      const database = readDatabase();
      if (database.users[user.email]) return false;
      database.users[user.email] = {
        name: user.name,
        salt: user.salt,
        passwordHash: user.passwordHash,
        favorites: [],
        emailVerified: false,
        verificationTokenHash: null,
        verificationExpiresAt: null,
        resetTokenHash: null,
        resetExpiresAt: null
      };
      writeDatabase(database);
      return true;
    },
    async createSession(token, email, expiresAt) {
      fileSessions.set(token, { email, expiresAt });
    },
    async getSessionUser(token) {
      const session = fileSessions.get(token);
      if (!session) return null;
      if (session.expiresAt <= Date.now()) {
        fileSessions.delete(token);
        return null;
      }
      const user = await this.getUser(session.email);
      return user ? { email: user.email, name: user.name, favorites: user.favorites } : null;
    },
    async deleteSession(token) {
      fileSessions.delete(token);
    },
    async updateFavorites(email, favorites) {
      const database = readDatabase();
      const user = database.users[email];
      if (!user) return null;
      user.favorites = favorites;
      writeDatabase(database);
      return user.favorites;
    },
    async setVerificationToken(email, tokenHash, expiresAt) {
      const database = readDatabase();
      const user = database.users[email];
      if (!user || user.emailVerified) return;
      user.verificationTokenHash = tokenHash;
      user.verificationExpiresAt = expiresAt;
      writeDatabase(database);
    },
    async verifyEmail(tokenHash) {
      const database = readDatabase();
      const entry = Object.entries(database.users).find(([, user]) =>
        user.verificationTokenHash === tokenHash && user.verificationExpiresAt > Date.now()
      );
      if (!entry) return null;
      const [email, user] = entry;
      user.emailVerified = true;
      user.verificationTokenHash = null;
      user.verificationExpiresAt = null;
      writeDatabase(database);
      return email;
    },
    async setPasswordResetToken(email, tokenHash, expiresAt) {
      const database = readDatabase();
      const user = database.users[email];
      if (!user || !user.emailVerified) return;
      user.resetTokenHash = tokenHash;
      user.resetExpiresAt = expiresAt;
      writeDatabase(database);
    },
    async resetPassword(tokenHash, salt, passwordHash) {
      const database = readDatabase();
      const entry = Object.entries(database.users).find(([, user]) =>
        user.resetTokenHash === tokenHash && user.resetExpiresAt > Date.now()
      );
      if (!entry) return false;
      const [email, user] = entry;
      user.salt = salt;
      user.passwordHash = passwordHash;
      user.resetTokenHash = null;
      user.resetExpiresAt = null;
      writeDatabase(database);
      for (const [token, session] of fileSessions) {
        if (session.email === email) fileSessions.delete(token);
      }
      return true;
    },
    async close() {}
  };
}

if (process.env.NODE_ENV === "production") {
  const missing = ["DATABASE_URL", "RESEND_API_KEY", "RESEND_FROM_EMAIL", "PUBLIC_APP_URL"]
    .filter(name => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing production environment variables: ${missing.join(", ")}`);
  }
  applicationUrl();
}

const store = process.env.DATABASE_URL
  ? createPostgresStore(process.env.DATABASE_URL)
  : createFileStore();

function hashOpaqueToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function applicationUrl() {
  const url = new URL(process.env.PUBLIC_APP_URL || `http://${HOST}:${PORT}`);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("PUBLIC_APP_URL must use HTTPS in production.");
  }
  return url;
}

async function sendEmail({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("RESEND_API_KEY and RESEND_FROM_EMAIL are required to send account emails.");
    }
    console.info(`[local email preview] To: ${to}\nSubject: ${subject}\n${text}`);
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from, to: [to], subject, text, html })
  });
  if (!response.ok) {
    throw new Error(`Email provider rejected the message (HTTP ${response.status}).`);
  }
}

let emailSender = sendEmail;

async function sendAccountLink({ email, type, token }) {
  const link = applicationUrl();
  link.search = new URLSearchParams({ [type]: token }).toString();
  const isVerification = type === "verify";
  const action = isVerification ? "Verify your Joybox email" : "Reset your Joybox password";
  const expiry = isVerification ? "24 hours" : "1 hour";
  const text = `${action}\n\nOpen this link to continue: ${link}\n\nThis link expires in ${expiry}. If you did not request this, you can ignore this email.`;
  const html = `<p>${action}</p><p><a href="${link}">Continue to Joybox</a></p><p>This link expires in ${expiry}. If you did not request this, you can ignore this email.</p>`;
  await emailSender({ to: email, subject: action, text, html });
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.on("data", chunk => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 16_384) {
        tooLarge = true;
        body = "";
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function getCookie(request, name) {
  const cookies = (request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return null;
}

async function currentUser(request) {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return null;
  return store.getSessionUser(token);
}

async function setSession(response, email) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await store.createSession(token, email, expiresAt);
  const secure = process.env.COOKIE_SECURE === "false"
    ? ""
    : process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
}

async function clearSession(request, response) {
  const token = getCookie(request, COOKIE_NAME);
  if (token) await store.deleteSession(token);
  response.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function checkOrigin(request) {
  if (!request.headers.origin) return true;
  try {
    return new URL(request.headers.origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function consumeAuthAttempt(request) {
  let address = request.socket.remoteAddress || "unknown";
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = request.headers["x-forwarded-for"];
    const candidate = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "";
    if (net.isIP(candidate)) address = candidate;
  }
  const now = Date.now();
  const attempts = (authAttempts.get(address) || []).filter(time => now - time < 15 * 60 * 1000);
  if (attempts.length >= 10) return false;
  attempts.push(now);
  authAttempts.set(address, attempts);
  if (authAttempts.size > 10_000) {
    for (const [key, timestamps] of authAttempts) {
      if (!timestamps.some(time => now - time < 15 * 60 * 1000)) authAttempts.delete(key);
    }
  }
  return true;
}

async function handleApi(request, response, url) {
  if (!checkOrigin(request)) return sendError(response, 403, "This request origin is not allowed.");

  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    return sendJson(response, 200, { user: await currentUser(request) });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/verify") {
    if (!consumeAuthAttempt(request)) return sendError(response, 429, "Too many requests. Try again in 15 minutes.");
    if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      return sendError(response, 415, "Content-Type must be application/json.");
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, error.status || 400, error.message);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(response, 400, "Request body must be a JSON object.");
    }
    const token = typeof body.token === "string" ? body.token : "";
    if (!token || token.length > 200) return sendError(response, 400, "The verification link is invalid or expired.");
    const email = await store.verifyEmail(hashOpaqueToken(token));
    if (!email) return sendError(response, 400, "The verification link is invalid or expired.");
    return sendJson(response, 200, { message: "Email verified. You can now sign in." });
  }

  if (request.method === "POST" && ["/api/auth/signup", "/api/auth/login"].includes(url.pathname)) {
    if (!consumeAuthAttempt(request)) return sendError(response, 429, "Too many sign-in attempts. Try again in 15 minutes.");
    if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      return sendError(response, 415, "Content-Type must be application/json.");
    }

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, error.status || 400, error.message);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(response, 400, "Request body must be a JSON object.");
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendError(response, 400, "Enter a valid email address.");
    }
    if (password.length < 8 || password.length > 128) {
      return sendError(response, 400, "Password must be between 8 and 128 characters.");
    }

    if (url.pathname === "/api/auth/signup") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 40) return sendError(response, 400, "Name must be between 1 and 40 characters.");
      const salt = randomBytes(16).toString("hex");
      const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
      try {
        const created = await store.createUser({ email, name, salt, passwordHash });
        if (!created) return sendError(response, 409, "An account with that email already exists.");
        const token = randomBytes(32).toString("base64url");
        await store.setVerificationToken(email, hashOpaqueToken(token), Date.now() + VERIFY_TTL_MS);
        await sendAccountLink({ email, type: "verify", token });
      } catch (error) {
        console.error("Could not complete account signup:", error);
        return sendError(response, 503, "Your account was created, but the verification email could not be sent. Use Resend verification to try again.");
      }
    } else {
      const user = await store.getUser(email);
      if (!user) return sendError(response, 401, "Email or password is incorrect.");
      if (!user.emailVerified) {
        return sendError(response, 403, "Verify your email before signing in. Use Resend verification if you need a new link.");
      }
      const passwordHash = await scrypt(password, user.salt, 64);
      const savedHash = Buffer.from(user.passwordHash, "hex");
      if (passwordHash.length !== savedHash.length || !timingSafeEqual(passwordHash, savedHash)) {
        return sendError(response, 401, "Email or password is incorrect.");
      }
    }

    if (url.pathname === "/api/auth/signup") {
      return sendJson(response, 200, { message: "Account created. Check your email for a verification link." });
    }

    await setSession(response, email);
    const user = await store.getUser(email);
    return sendJson(response, 200, { user: { email, name: user.name, favorites: user.favorites } });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    await clearSession(request, response);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "POST" && ["/api/auth/resend-verification", "/api/auth/forgot-password"].includes(url.pathname)) {
    if (!consumeAuthAttempt(request)) return sendError(response, 429, "Too many requests. Try again in 15 minutes.");
    if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      return sendError(response, 415, "Content-Type must be application/json.");
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, error.status || 400, error.message);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(response, 400, "Request body must be a JSON object.");
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendError(response, 400, "Enter a valid email address.");
    }
    const isVerification = url.pathname.endsWith("resend-verification");
    try {
      const user = await store.getUser(email);
      if (user && (isVerification ? !user.emailVerified : user.emailVerified)) {
        const token = randomBytes(32).toString("base64url");
        const tokenHash = hashOpaqueToken(token);
        if (isVerification) {
          await store.setVerificationToken(email, tokenHash, Date.now() + VERIFY_TTL_MS);
          await sendAccountLink({ email, type: "verify", token });
        } else {
          await store.setPasswordResetToken(email, tokenHash, Date.now() + RESET_TTL_MS);
          await sendAccountLink({ email, type: "reset", token });
        }
      }
    } catch (error) {
      console.error("Could not process account email request:", error);
      return sendError(response, 503, "The email could not be sent right now. Please try again later.");
    }
    return sendJson(response, 200, {
      message: isVerification
        ? "If that account needs verification, we sent a new link."
        : "If that account exists, we sent a password reset link."
    });
  }

  if (request.method === "POST" && url.pathname === "/api/auth/reset-password") {
    if (!consumeAuthAttempt(request)) return sendError(response, 429, "Too many requests. Try again in 15 minutes.");
    if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      return sendError(response, 415, "Content-Type must be application/json.");
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, error.status || 400, error.message);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(response, 400, "Request body must be a JSON object.");
    }
    const token = typeof body.token === "string" ? body.token : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!token || token.length > 200) return sendError(response, 400, "The password reset link is invalid or expired.");
    if (password.length < 8 || password.length > 128) {
      return sendError(response, 400, "Password must be between 8 and 128 characters.");
    }
    const salt = randomBytes(16).toString("hex");
    const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
    try {
      const updated = await store.resetPassword(hashOpaqueToken(token), salt, passwordHash);
      if (!updated) return sendError(response, 400, "The password reset link is invalid or expired.");
      return sendJson(response, 200, { message: "Password updated. Sign in with your new password." });
    } catch (error) {
      console.error("Could not reset account password:", error);
      return sendError(response, 500, "Your password could not be updated. Please try again.");
    }
  }

  if (url.pathname === "/api/favorites" && request.method === "GET") {
    const user = await currentUser(request);
    if (!user) return sendError(response, 401, "Sign in to see your saved games.");
    return sendJson(response, 200, { favorites: user.favorites });
  }

  if (url.pathname === "/api/favorites" && request.method === "PUT") {
    const user = await currentUser(request);
    if (!user) return sendError(response, 401, "Sign in to save your favorite games.");
    if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      return sendError(response, 415, "Content-Type must be application/json.");
    }
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendError(response, error.status || 400, error.message);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(response, 400, "Request body must be a JSON object.");
    }
    if (!Array.isArray(body.favorites) || body.favorites.length > GAME_TITLES.size
      || body.favorites.some(title => typeof title !== "string" || !GAME_TITLES.has(title))) {
      return sendError(response, 400, "The favorites list contains invalid games.");
    }
    try {
      const updatedFavorites = await store.updateFavorites(user.email, [...new Set(body.favorites)]);
      if (!updatedFavorites) return sendError(response, 401, "Sign in to save your favorite games.");
      return sendJson(response, 200, { favorites: updatedFavorites });
    } catch (error) {
      console.error("Could not save favorites:", error);
      return sendError(response, 500, "Your favorites could not be saved. Please try again.");
    }
  }

  return sendError(response, 404, "API endpoint not found.");
}

const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    response.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
  response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/healthz" && request.method === "GET") {
      await store.healthCheck();
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendError(response, 405, "Method not allowed.");
      return;
    }
    const publicFiles = {
      "/": "index.html",
      "/index.html": "index.html",
      "/privacy.html": "privacy.html",
      "/terms.html": "terms.html"
    };
    const publicFile = publicFiles[url.pathname];
    if (!publicFile) {
      sendError(response, 404, "Page not found.");
      return;
    }
    const html = fs.readFileSync(path.join(__dirname, publicFile));
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "Content-Length": html.length
    });
    response.end(request.method === "HEAD" ? undefined : html);
  } catch (error) {
    console.error("Request failed:", error);
    if (!response.headersSent) sendError(response, 500, "The server could not complete your request.");
    else response.destroy();
  }
});

if (require.main === module) {
  store.initialize().then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`Joybox is running at http://${HOST}:${PORT}`);
    });
  }).catch(error => {
    console.error("Could not initialize the account database:", error);
    process.exit(1);
  });

  const shutdown = () => {
    server.close(async error => {
      if (error) console.error("Server shutdown failed:", error);
      try {
        await store.close();
      } catch (closeError) {
        console.error("Database shutdown failed:", closeError);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

module.exports = server;
module.exports.setEmailSenderForTests = sender => {
  emailSender = sender;
};
