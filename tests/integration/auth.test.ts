import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("JWT Authentication Integration Tests", () => {
  const testUser = {
    username: `testuser_${Date.now()}`,
    password: "testpassword123",
  };

  it("should return 401 when accessing protected route without token", async () => {
    const response = await SELF.fetch("http://local.test/api/auth/me");
    expect(response.status).toBe(401);
    const body = await response.json<any>();
    expect(body.code).toBe(401);
    expect(body.message).toContain("鉴权失败");
  });

  it("should successfully register a new user", async () => {
    const response = await SELF.fetch("http://local.test/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testUser),
    });

    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.code).toBe(200);
    expect(body.data).toHaveProperty("id");
    expect(body.data.username).toBe(testUser.username);
  });

  it("should login successfully and return a valid JWT token", async () => {
    // SQLite test DB is isolated between tests, so register the user first in this block
    await SELF.fetch("http://local.test/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testUser),
    });

    const response = await SELF.fetch("http://local.test/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testUser),
    });

    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.code).toBe(200);
    expect(body.data).toHaveProperty("token");
    expect(body.data.user.username).toBe(testUser.username);

    const token = body.data.token;

    // Use token to access protected me endpoint
    const meResponse = await SELF.fetch("http://local.test/api/auth/me", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(meResponse.status).toBe(200);
    const meBody = await meResponse.json<any>();
    expect(meBody.code).toBe(200);
    expect(meBody.data.username).toBe(testUser.username);
    expect(meBody.data.roles).toContain("admin");
  });
});
