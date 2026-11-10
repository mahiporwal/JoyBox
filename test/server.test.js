"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, test } = require("node:test");

const dataDirectory = path.join(__dirname, "..", ".joybox-test-data");
process.env.JOYBOX_DATA_DIR = dataDirectory;
delete process.env.DATABASE_URL;
process.env.TRUST_PROXY = "true";
const server = require("../server");

let baseUrl;
let sessionCookie = null;
let requestNumber = 0;
const sentEmails = [];
server.setEmailSenderForTests(async email => sentEmails.push(email));

before(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  fs.rmSync(dataDirectory, { recursive: true, force: true });
});

async function request(endpoint, { method = "GET", body, withCookie = true } = {}) {
  const headers = { "X-Forwarded-For": `198.51.100.${++requestNumber % 250 + 1}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (withCookie && sessionCookie) headers.Cookie = sessionCookie;

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) sessionCookie = setCookie.split(";", 1)[0];
  return { response, payload: await response.json() };
}

function emailToken(email, key) {
  const link = email.text.match(/continue:\s*(.+)/i)?.[1];
  assert.ok(link, "email contains a continuation link");
  return new URL(link).searchParams.get(key);
}

test("static UI is served with browser security headers", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Joybox/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.ok(response.headers.get("content-security-policy"));
  const privacy = await fetch(`${baseUrl}/privacy.html`);
  assert.equal(privacy.status, 200);
  assert.match(await privacy.text(), /DRAFT TEMPLATE/);
  const terms = await fetch(`${baseUrl}/terms.html`);
  assert.equal(terms.status, 200);
  assert.match(await terms.text(), /DRAFT TEMPLATE/);
});

test("health endpoint reports readiness", async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("signup, session, favorites, logout, and login work end to end", async () => {
  sessionCookie = null;
  const invalidBody = await request("/api/auth/login", { method: "POST", body: null });
  assert.equal(invalidBody.response.status, 400);

  const signup = await request("/api/auth/signup", {
    method: "POST",
    body: { name: "  Player One ", email: "PLAYER@example.com", password: "correct horse" }
  });
  assert.equal(signup.response.status, 200);
  assert.match(signup.payload.message, /Check your email/);
  assert.equal(signup.response.headers.get("set-cookie"), null);
  assert.equal(sentEmails.at(-1).to, "player@example.com");

  const unverifiedLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: "player@example.com", password: "correct horse" }
  });
  assert.equal(unverifiedLogin.response.status, 403);

  const verificationToken = emailToken(sentEmails.at(-1), "verify");
  assert.ok(verificationToken);
  const verified = await request("/api/auth/verify", {
    method: "POST",
    body: { token: verificationToken }
  });
  assert.equal(verified.response.status, 200);
  assert.match(verified.payload.message, /verified/);
  assert.equal((await request("/api/auth/verify", {
    method: "POST",
    body: { token: verificationToken }
  })).response.status, 400);

  const signupLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: "player@example.com", password: "correct horse" }
  });
  assert.equal(signupLogin.response.status, 200);
  assert.match(signupLogin.response.headers.get("set-cookie"), /HttpOnly/);
  const me = await request("/api/auth/me");
  assert.equal(me.payload.user.email, "player@example.com");

  const saved = await request("/api/favorites", {
    method: "PUT",
    body: { favorites: ["Star Catcher", "Bubble Pop", "Star Catcher"] }
  });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.payload.favorites, ["Star Catcher", "Bubble Pop"]);
  const listed = await request("/api/favorites");
  assert.deepEqual(listed.payload.favorites, saved.payload.favorites);

  const invalidFavorite = await request("/api/favorites", {
    method: "PUT",
    body: { favorites: ["Not a Joybox game"] }
  });
  assert.equal(invalidFavorite.response.status, 400);

  const logout = await request("/api/auth/logout", { method: "POST" });
  assert.equal(logout.response.status, 200);
  assert.equal((await request("/api/auth/me")).payload.user, null);

  const login = await request("/api/auth/login", {
    method: "POST",
    body: { email: "player@example.com", password: "correct horse" }
  });
  assert.equal(login.response.status, 200);
  assert.deepEqual(login.payload.user.favorites, ["Star Catcher", "Bubble Pop"]);
  assert.equal((await request("/api/auth/login", {
    method: "POST",
    body: { email: "player@example.com", password: "incorrect password" }
  })).response.status, 401);

  const forgot = await request("/api/auth/forgot-password", {
    method: "POST",
    body: { email: "player@example.com" },
    withCookie: false
  });
  assert.equal(forgot.response.status, 200);
  const resetToken = emailToken(sentEmails.at(-1), "reset");
  assert.ok(resetToken);
  const reset = await request("/api/auth/reset-password", {
    method: "POST",
    body: { token: resetToken, password: "a brand new password" },
    withCookie: false
  });
  assert.equal(reset.response.status, 200);
  assert.equal((await request("/api/auth/reset-password", {
    method: "POST",
    body: { token: resetToken, password: "another new password" },
    withCookie: false
  })).response.status, 400);
  assert.equal((await request("/api/auth/me")).payload.user, null);
  const newPasswordLogin = await request("/api/auth/login", {
    method: "POST",
    body: { email: "player@example.com", password: "a brand new password" },
    withCookie: false
  });
  assert.equal(newPasswordLogin.response.status, 200);
});

test("simultaneous signup requests cannot overwrite the same account", async () => {
  sessionCookie = null;
  const attempts = await Promise.all([
    request("/api/auth/signup", {
      method: "POST",
      withCookie: false,
      body: { name: "First", email: "race@example.com", password: "first password" }
    }),
    request("/api/auth/signup", {
      method: "POST",
      withCookie: false,
      body: { name: "Second", email: "race@example.com", password: "second password" }
    })
  ]);
  assert.deepEqual(attempts.map(result => result.response.status).sort(), [200, 409]);

  const distinctAttempts = await Promise.all([
    request("/api/auth/signup", {
      method: "POST",
      withCookie: false,
      body: { name: "Alpha", email: "alpha@example.com", password: "alpha password" }
    }),
    request("/api/auth/signup", {
      method: "POST",
      withCookie: false,
      body: { name: "Beta", email: "beta@example.com", password: "beta password" }
    })
  ]);
  assert.deepEqual(distinctAttempts.map(result => result.response.status), [200, 200]);
  for (const email of ["alpha@example.com", "beta@example.com"]) {
    const sent = sentEmails.findLast(message => message.to === email);
    const verified = await request("/api/auth/verify", {
      method: "POST",
      withCookie: false,
      body: { token: emailToken(sent, "verify") }
    });
    assert.equal(verified.response.status, 200);
  }
  for (const [email, password] of [
    ["alpha@example.com", "alpha password"],
    ["beta@example.com", "beta password"]
  ]) {
    const login = await request("/api/auth/login", {
      method: "POST",
      withCookie: false,
      body: { email, password }
    });
    assert.equal(login.response.status, 200);
  }
});

test("resending verification invalidates older links and hides unknown accounts", async () => {
  const signup = await request("/api/auth/signup", {
    method: "POST",
    withCookie: false,
    body: { name: "Needs Verify", email: "resend@example.com", password: "password one" }
  });
  assert.equal(signup.response.status, 200);
  const oldToken = emailToken(sentEmails.at(-1), "verify");
  const resend = await request("/api/auth/resend-verification", {
    method: "POST",
    withCookie: false,
    body: { email: "resend@example.com" }
  });
  assert.equal(resend.response.status, 200);
  assert.equal((await request("/api/auth/verify", {
    method: "POST",
    withCookie: false,
    body: { token: oldToken }
  })).response.status, 400);
  const newToken = emailToken(sentEmails.at(-1), "verify");
  assert.equal((await request("/api/auth/verify", {
    method: "POST",
    withCookie: false,
    body: { token: newToken }
  })).response.status, 200);
  const unknown = await request("/api/auth/forgot-password", {
    method: "POST",
    withCookie: false,
    body: { email: "unknown@example.com" }
  });
  assert.equal(unknown.response.status, 200);
  assert.match(unknown.payload.message, /If that account exists/);
});
