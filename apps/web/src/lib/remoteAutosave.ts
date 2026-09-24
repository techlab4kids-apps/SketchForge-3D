import { SKF_MEDIA_TYPE } from "@/lib/skfProject";

export const REMOTE_AUTOSAVE_DB_NAME = "sketchForge.remoteAutosave";
export const REMOTE_AUTOSAVE_STORE_NAME = "pending";
export const REMOTE_AUTOSAVE_DEBOUNCE_MS = 1_500;
export const REMOTE_AUTOSAVE_MAX_WAIT_MS = 30_000;
export const REMOTE_AUTOSAVE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export type RemoteAutosaveState = "local" | "queued" | "saving" | "saved" | "conflict" | "offline" | "error";

export type RemoteAutosaveStatus = {
  projectId: string;
  state: RemoteAutosaveState;
  revision?: number;
  attempts: number;
  error?: string;
};

export type RemoteAutosaveRecord = {
  projectId: string;
  clientRevision: number;
  baseRevision: number | null;
  idempotencyKey: string;
  skfPackage: Uint8Array;
  thumbnail?: string;
  attempts: number;
  state: RemoteAutosaveState;
  nextAttemptAt: number;
  updatedAt: number;
  lastError?: string;
};

export type RemoteAutosaveStorage = {
  list(): Promise<RemoteAutosaveRecord[]>;
  get(projectId: string): Promise<RemoteAutosaveRecord | null>;
  put(record: RemoteAutosaveRecord): Promise<void>;
  delete(projectId: string): Promise<void>;
};

export type RemoteAutosaveAdapterOptions = {
  endpoint?: string | null;
  storage?: RemoteAutosaveStorage | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  random?: () => number;
  createId?: () => string;
  debounceMs?: number;
  maxWaitMs?: number;
  retryDelaysMs?: readonly number[];
};

export type RemoteAutosaveInput = {
  projectId: string;
  clientRevision: number;
  skfPackage: Uint8Array;
  thumbnail?: string;
};

export function retryDelayMs(attempt: number, delays: readonly number[] = REMOTE_AUTOSAVE_RETRY_DELAYS_MS, random = Math.random) {
  const index = Math.min(Math.max(0, attempt - 1), delays.length - 1);
  const base = delays[index] ?? delays[delays.length - 1] ?? 30_000;
  return Math.round(base * (0.8 + random() * 0.4));
}

function defaultCreateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `autosave-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function openRemoteAutosaveDb(factory: IDBFactory) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(REMOTE_AUTOSAVE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(REMOTE_AUTOSAVE_STORE_NAME)) {
        request.result.createObjectStore(REMOTE_AUTOSAVE_STORE_NAME, { keyPath: "projectId" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open remote autosave storage"));
    request.onsuccess = () => resolve(request.result);
  });
}

export function createIndexedDbRemoteAutosaveStorage(factory: IDBFactory): RemoteAutosaveStorage {
  return {
    async list() {
      const database = await openRemoteAutosaveDb(factory);
      return new Promise<RemoteAutosaveRecord[]>((resolve, reject) => {
        const transaction = database.transaction(REMOTE_AUTOSAVE_STORE_NAME, "readonly");
        const request = transaction.objectStore(REMOTE_AUTOSAVE_STORE_NAME).getAll();
        request.onerror = () => reject(request.error ?? new Error("Could not list remote autosave records"));
        request.onsuccess = () => resolve((request.result as RemoteAutosaveRecord[]) ?? []);
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => {
          database.close();
          reject(transaction.error ?? new Error("Could not list remote autosave records"));
        };
      });
    },
    async get(projectId) {
      const database = await openRemoteAutosaveDb(factory);
      return new Promise<RemoteAutosaveRecord | null>((resolve, reject) => {
        const transaction = database.transaction(REMOTE_AUTOSAVE_STORE_NAME, "readonly");
        const request = transaction.objectStore(REMOTE_AUTOSAVE_STORE_NAME).get(projectId);
        request.onerror = () => reject(request.error ?? new Error("Could not load remote autosave record"));
        request.onsuccess = () => resolve((request.result as RemoteAutosaveRecord | undefined) ?? null);
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => {
          database.close();
          reject(transaction.error ?? new Error("Could not load remote autosave record"));
        };
      });
    },
    async put(record) {
      const database = await openRemoteAutosaveDb(factory);
      return new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(REMOTE_AUTOSAVE_STORE_NAME, "readwrite");
        transaction.objectStore(REMOTE_AUTOSAVE_STORE_NAME).put(record);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error ?? new Error("Could not save remote autosave record"));
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error ?? new Error("Could not save remote autosave record"));
        };
      });
    },
    async delete(projectId) {
      const database = await openRemoteAutosaveDb(factory);
      return new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(REMOTE_AUTOSAVE_STORE_NAME, "readwrite");
        transaction.objectStore(REMOTE_AUTOSAVE_STORE_NAME).delete(projectId);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error ?? new Error("Could not delete remote autosave record"));
        };
      });
    },
  };
}

function dataUrlToBlob(dataUrl: string) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) throw new Error("Thumbnail is not a data URL");
  const mediaType = match[1] || "application/octet-stream";
  const encoded = match[3] ?? "";
  const binary = match[2] ? atob(encoded) : decodeURIComponent(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mediaType });
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class RemoteAutosaveAdapter {
  readonly enabled: boolean;
  private readonly endpoint: string;
  private readonly storage: RemoteAutosaveStorage | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly random: () => number;
  private readonly createId: () => string;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly records = new Map<string, RemoteAutosaveRecord>();
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dirtySince = new Map<string, number>();
  private readonly listeners = new Set<(status: RemoteAutosaveStatus) => void>();

  constructor(options: RemoteAutosaveAdapterOptions = {}) {
    this.endpoint = options.endpoint?.trim() ?? "";
    this.enabled = this.endpoint.length > 0;
    this.storage = options.storage === undefined
      ? typeof window !== "undefined" && window.indexedDB
        ? createIndexedDbRemoteAutosaveStorage(window.indexedDB)
        : null
      : options.storage;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
    this.random = options.random ?? Math.random;
    this.createId = options.createId ?? defaultCreateId;
    this.debounceMs = options.debounceMs ?? REMOTE_AUTOSAVE_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? REMOTE_AUTOSAVE_MAX_WAIT_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? REMOTE_AUTOSAVE_RETRY_DELAYS_MS;
    if (this.enabled) void this.resume();
  }

  subscribe(listener: (status: RemoteAutosaveStatus) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(projectId: string) {
    const record = this.records.get(projectId);
    return record ? this.toStatus(record) : undefined;
  }

  async enqueue(input: RemoteAutosaveInput) {
    if (!this.enabled) return;
    const previous = this.records.get(input.projectId) ?? (this.storage ? await this.storage.get(input.projectId) : null);
    const record: RemoteAutosaveRecord = {
      projectId: input.projectId,
      clientRevision: input.clientRevision,
      baseRevision: previous?.baseRevision ?? null,
      idempotencyKey: this.createId(),
      skfPackage: input.skfPackage,
      thumbnail: input.thumbnail ?? previous?.thumbnail,
      attempts: 0,
      state: "queued",
      nextAttemptAt: 0,
      updatedAt: this.now(),
    };
    this.records.set(record.projectId, record);
    await this.persist(record);
    this.emit(record);
    this.schedule(record.projectId);
  }

  async setThumbnail(projectId: string, thumbnail: string) {
    if (!this.enabled) return;
    const record = this.records.get(projectId) ?? (this.storage ? await this.storage.get(projectId) : null);
    if (!record || record.state === "conflict" || record.state === "error") return;
    const replaceInFlightPayload = this.inFlight.has(projectId) || record.state === "saved" || record.state === "offline";
    const updated: RemoteAutosaveRecord = {
      ...record,
      thumbnail,
      idempotencyKey: replaceInFlightPayload ? this.createId() : record.idempotencyKey,
      state: "queued",
      nextAttemptAt: record.state === "offline" ? record.nextAttemptAt : 0,
      updatedAt: this.now(),
      lastError: undefined,
    };
    this.records.set(projectId, updated);
    await this.persist(updated);
    this.emit(updated);
    this.schedule(projectId);
  }

  async flush(projectId?: string) {
    if (!this.enabled) return;
    const projectIds = projectId ? [projectId] : [...this.records.keys()];
    await Promise.all(projectIds.map((id) => this.flushProject(id)));
  }

  destroy() {
    for (const timer of this.timers.values()) this.clearTimeoutImpl(timer);
    this.timers.clear();
    this.dirtySince.clear();
    this.listeners.clear();
  }

  private async resume() {
    if (!this.storage) return;
    try {
      for (const record of await this.storage.list()) {
        this.records.set(record.projectId, record);
        if (record.state === "queued" || record.state === "offline") this.schedule(record.projectId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load remote autosave queue";
      this.listeners.forEach((listener) => listener({ projectId: "", state: "error", attempts: 0, error: message }));
    }
  }

  private async persist(record: RemoteAutosaveRecord) {
    try {
      await this.storage?.put(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not persist remote autosave queue";
      this.emitStatus({ ...this.toStatus(record), state: "error", error: message });
      throw error;
    }
  }

  private schedule(projectId: string) {
    if (!this.enabled || this.timers.has(projectId)) return;
    const started = this.dirtySince.get(projectId) ?? this.now();
    this.dirtySince.set(projectId, started);
    const current = this.records.get(projectId);
    const retryDelay = current ? Math.max(0, current.nextAttemptAt - this.now()) : 0;
    const elapsed = Math.max(0, this.now() - started);
    const delay = retryDelay > 0 ? retryDelay : Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - elapsed));
    const timer = this.setTimeoutImpl(() => {
      this.timers.delete(projectId);
      void this.flushProject(projectId).catch((error) => {
        const message = error instanceof Error ? error.message : "Could not flush remote autosave";
        this.emitStatus({ projectId, state: "error", attempts: this.records.get(projectId)?.attempts ?? 0, error: message });
      });
    }, delay);
    this.timers.set(projectId, timer);
  }

  private async flushProject(projectId: string) {
    if (!this.enabled || this.inFlight.has(projectId)) return;
    const record = this.records.get(projectId);
    if (!record || record.state === "saved" || record.state === "conflict" || record.state === "error") return;
    if (record.nextAttemptAt > this.now()) {
      this.schedule(projectId);
      return;
    }

    this.inFlight.add(projectId);
    const requestRecord: RemoteAutosaveRecord = {
      ...record,
      attempts: record.attempts + 1,
      state: "saving",
      updatedAt: this.now(),
    };
    this.records.set(projectId, requestRecord);
    await this.persist(requestRecord);
    this.emit(requestRecord);

    try {
      const form = new FormData();
      form.set("project_id", requestRecord.projectId);
      form.set("client_revision", String(requestRecord.clientRevision));
      form.set("base_revision", requestRecord.baseRevision === null ? "" : String(requestRecord.baseRevision));
      form.set("idempotency_key", requestRecord.idempotencyKey);
      form.set("project", new Blob([new Uint8Array(requestRecord.skfPackage)], { type: SKF_MEDIA_TYPE }), `${requestRecord.projectId}.skf`);
      if (requestRecord.thumbnail) form.set("thumbnail", dataUrlToBlob(requestRecord.thumbnail), `${requestRecord.projectId}.png`);
      const response = await this.fetchImpl(this.endpoint, { method: "POST", body: form, credentials: "include" });
      if (response.status === 409) {
        await this.markConflict(projectId, requestRecord, "The remote project changed before this save could be applied");
        return;
      }
      if (!response.ok) {
        const message = `Remote autosave failed with HTTP ${response.status}`;
        if (!isRetryableStatus(response.status)) {
          await this.markTerminalError(projectId, requestRecord, message);
          return;
        }
        throw new Error(message);
      }
      const payload = await response.json().catch(() => null) as { revision?: number | string; base_revision?: number | string } | null;
      const serverRevision = Number(payload?.revision ?? payload?.base_revision);
      const latest = this.records.get(projectId);
      if (latest) {
        const completed: RemoteAutosaveRecord = {
          ...latest,
          baseRevision: Number.isFinite(serverRevision) ? serverRevision : latest.baseRevision,
          state: latest.idempotencyKey === requestRecord.idempotencyKey ? "saved" : "queued",
          attempts: latest.idempotencyKey === requestRecord.idempotencyKey ? 0 : latest.attempts,
          nextAttemptAt: 0,
          updatedAt: this.now(),
          lastError: undefined,
        };
        this.records.set(projectId, completed);
        if (completed.state === "saved") this.dirtySince.delete(projectId);
        await this.persist(completed);
        this.emit(completed);
      }
    } catch (error) {
      await this.markRetryableFailure(projectId, requestRecord, error);
    } finally {
      this.inFlight.delete(projectId);
      const latest = this.records.get(projectId);
      if (latest?.state === "queued") this.schedule(projectId);
    }
  }

  private async markConflict(projectId: string, requestRecord: RemoteAutosaveRecord, message: string) {
    const latest = this.records.get(projectId) ?? requestRecord;
    const record = { ...latest, state: "conflict" as const, nextAttemptAt: 0, updatedAt: this.now(), lastError: message };
    this.records.set(projectId, record);
    await this.persist(record);
    this.emit(record);
  }

  private async markTerminalError(projectId: string, requestRecord: RemoteAutosaveRecord, message: string) {
    const latest = this.records.get(projectId) ?? requestRecord;
    const record = { ...latest, state: "error" as const, nextAttemptAt: 0, updatedAt: this.now(), lastError: message };
    this.records.set(projectId, record);
    await this.persist(record);
    this.emit(record);
  }

  private async markRetryableFailure(projectId: string, requestRecord: RemoteAutosaveRecord, error: unknown) {
    const latest = this.records.get(projectId) ?? requestRecord;
    const attempts = requestRecord.attempts;
    const delay = retryDelayMs(attempts, this.retryDelaysMs, this.random);
    const record = {
      ...latest,
      state: "offline" as const,
      nextAttemptAt: this.now() + delay,
      updatedAt: this.now(),
      lastError: error instanceof Error ? error.message : "Remote autosave is temporarily unavailable",
    };
    this.records.set(projectId, record);
    await this.persist(record);
    this.emit(record);
    this.schedule(projectId);
  }

  private toStatus(record: RemoteAutosaveRecord): RemoteAutosaveStatus {
    return {
      projectId: record.projectId,
      state: record.state,
      revision: record.baseRevision ?? undefined,
      attempts: record.attempts,
      error: record.lastError,
    };
  }

  private emit(record: RemoteAutosaveRecord) {
    this.emitStatus(this.toStatus(record));
  }

  private emitStatus(status: RemoteAutosaveStatus) {
    this.listeners.forEach((listener) => listener(status));
  }
}

let adapter: RemoteAutosaveAdapter | null = null;

export function getRemoteAutosaveAdapter() {
  if (!adapter) {
    adapter = new RemoteAutosaveAdapter({ endpoint: process.env.NEXT_PUBLIC_TL4K_AUTOSAVE_URL });
  }
  return adapter;
}
