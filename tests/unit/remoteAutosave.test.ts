import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteAutosaveAdapter, type RemoteAutosaveRecord, type RemoteAutosaveStorage } from "@/lib/remoteAutosave";

function memoryStorage() {
  const records = new Map<string, RemoteAutosaveRecord>();
  const storage: RemoteAutosaveStorage = {
    async list() { return [...records.values()]; },
    async get(projectId) { return records.get(projectId) ?? null; },
    async put(record) { records.set(record.projectId, record); },
    async delete(projectId) { records.delete(projectId); },
  };
  return { records, storage };
}

function successfulResponse(revision: number) {
  return {
    ok: true,
    status: 200,
    async json() { return { revision }; },
  } as Response;
}

describe("remote autosave adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a no-op when no endpoint is configured", async () => {
    const fetchImpl = vi.fn();
    const adapter = new RemoteAutosaveAdapter({ fetchImpl });

    await adapter.enqueue({ projectId: "project-1", clientRevision: 1, skfPackage: new Uint8Array([1, 2, 3]) });

    expect(adapter.enabled).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(adapter.getStatus("project-1")).toBeUndefined();
  });

  it("uploads the latest .skf package and thumbnail as multipart data", async () => {
    vi.useFakeTimers();
    const { records, storage } = memoryStorage();
    const fetchImpl = vi.fn(async () => successfulResponse(7));
    let id = 0;
    const adapter = new RemoteAutosaveAdapter({
      endpoint: "/api/tl4k/autosave",
      storage,
      fetchImpl,
      createId: () => `id-${++id}`,
      random: () => 0,
    });

    await adapter.enqueue({ projectId: "project-1", clientRevision: 4, skfPackage: new Uint8Array([1]) });
    await adapter.enqueue({ projectId: "project-1", clientRevision: 5, skfPackage: new Uint8Array([2, 3]), thumbnail: "data:image/png;base64,AA==" });
    await vi.advanceTimersByTimeAsync(1_500);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(request.credentials).toBe("include");
    const form = request.body as FormData;
    expect(form.get("project_id")).toBe("project-1");
    expect(form.get("client_revision")).toBe("5");
    expect(form.get("base_revision")).toBe("");
    expect(form.get("idempotency_key")).toBe("id-2");
    expect((form.get("project") as File).name).toBe("project-1.skf");
    expect((form.get("thumbnail") as File).name).toBe("project-1.png");
    expect(records.get("project-1")?.state).toBe("saved");
    expect(records.get("project-1")?.baseRevision).toBe(7);
    adapter.destroy();
  });

  it("updates a queued thumbnail without changing its pending idempotency key", async () => {
    vi.useFakeTimers();
    const { records, storage } = memoryStorage();
    const fetchImpl = vi.fn(async () => successfulResponse(7));
    const adapter = new RemoteAutosaveAdapter({
      endpoint: "/api/tl4k/autosave",
      storage,
      fetchImpl,
      random: () => 0,
      createId: () => "stable-key",
    });

    await adapter.enqueue({ projectId: "project-1", clientRevision: 1, skfPackage: new Uint8Array([1]) });
    await adapter.setThumbnail("project-1", "data:image/png;base64,AA==");
    await vi.advanceTimersByTimeAsync(1_500);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const form = (fetchImpl.mock.calls[0]?.[1] as RequestInit).body as FormData;
    expect(form.get("idempotency_key")).toBe("stable-key");
    expect((form.get("thumbnail") as File).name).toBe("project-1.png");
    expect(records.get("project-1")?.state).toBe("saved");
    adapter.destroy();
  });

  it("retries transient failures with the same idempotency key", async () => {
    vi.useFakeTimers();
    const { records, storage } = memoryStorage();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network unavailable");
      return successfulResponse(9);
    });
    const adapter = new RemoteAutosaveAdapter({
      endpoint: "/api/tl4k/autosave",
      storage,
      fetchImpl,
      random: () => 0,
      createId: () => "stable-key",
    });

    await adapter.enqueue({ projectId: "project-1", clientRevision: 1, skfPackage: new Uint8Array([1]) });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(records.get("project-1")?.state).toBe("offline");
    const firstForm = (fetchImpl.mock.calls[0]?.[1] as RequestInit).body as FormData;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondForm = (fetchImpl.mock.calls[1]?.[1] as RequestInit).body as FormData;
    expect(secondForm.get("idempotency_key")).toBe(firstForm.get("idempotency_key"));
    expect(records.get("project-1")?.state).toBe("saved");
    adapter.destroy();
  });

  it("marks conflicts without retrying or overwriting the queued project", async () => {
    vi.useFakeTimers();
    const { records, storage } = memoryStorage();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({}) }) as Response);
    const adapter = new RemoteAutosaveAdapter({ endpoint: "/api/tl4k/autosave", storage, fetchImpl, random: () => 0 });

    await adapter.enqueue({ projectId: "project-1", clientRevision: 1, skfPackage: new Uint8Array([1]) });
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(records.get("project-1")?.state).toBe("conflict");
    expect(records.get("project-1")?.lastError).toContain("remote project changed");
    adapter.destroy();
  });
});
