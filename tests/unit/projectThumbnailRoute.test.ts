import { describe, expect, it } from "vitest";
import { DELETE, GET, POST } from "@/app/api/project-thumbnail/route";

function missingThumbnailRequest(url: string, headers?: HeadersInit) {
  return new Request(`${url}/api/project-thumbnail?projectId=missing-thumbnail`, { headers });
}

describe("project thumbnail request origins", () => {
  it("allows same-origin requests on a public HTTPS host", async () => {
    const response = await GET(missingThumbnailRequest("https://projects.example.test", {
      Origin: "https://projects.example.test",
      "Sec-Fetch-Site": "same-origin",
    }));

    expect(response.status).toBe(404);
  });

  it("uses forwarded host and protocol behind a TLS reverse proxy", async () => {
    const response = await GET(missingThumbnailRequest("http://localhost:3000", {
      Origin: "https://projects.example.test",
      "Sec-Fetch-Site": "same-origin",
      "X-Forwarded-Host": "projects.example.test",
      "X-Forwarded-Proto": "https",
    }));

    expect(response.status).toBe(404);
  });

  it("keeps the gateway port when validating the editor origin", async () => {
    const response = await GET(missingThumbnailRequest("http://sketchforge:3000", {
      Origin: "http://localhost:3579",
      "Sec-Fetch-Site": "same-origin",
      "X-Forwarded-Host": "localhost:3579",
      "X-Forwarded-Proto": "http",
    }));

    expect(response.status).toBe(404);
  });

  it("rejects a different origin", async () => {
    const response = await GET(missingThumbnailRequest("https://projects.example.test", {
      Origin: "https://other.example.test",
      "Sec-Fetch-Site": "cross-site",
    }));

    expect(response.status).toBe(403);
  });

  it("allows same-origin uploads to proceed to request validation", async () => {
    const response = await POST(new Request("https://projects.example.test/api/project-thumbnail", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://projects.example.test",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid thumbnail request" });
  });

  it("binds an authenticated thumbnail to its SketchForge session", async () => {
    const projectId = `route-session-${Date.now()}`;
    const baseUrl = `https://projects.example.test/api/project-thumbnail?projectId=${projectId}`;
    const headers = {
      "Content-Type": "application/json",
      Origin: "https://projects.example.test",
      "Sec-Fetch-Site": "same-origin",
      "X-SketchForge-Session": "session-a",
    };
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    try {
      const saved = await POST(new Request(baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId, dataUrl }),
      }));
      expect(saved.status).toBe(200);

      const otherSession = await POST(new Request(baseUrl, {
        method: "POST",
        headers: { ...headers, "X-SketchForge-Session": "session-b" },
        body: JSON.stringify({ projectId, dataUrl }),
      }));
      expect(otherSession.status).toBe(403);

      const ownRead = await GET(new Request(baseUrl, { headers }));
      expect(ownRead.status).toBe(200);
      const otherRead = await GET(new Request(baseUrl, {
        headers: { ...headers, "X-SketchForge-Session": "session-b" },
      }));
      expect(otherRead.status).toBe(403);
    } finally {
      await DELETE(new Request(baseUrl, { headers, method: "DELETE" }));
    }
  });
});
