import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";

export const revalidate = false;

const THUMBNAIL_ROOT = process.env.SKETCHFORGE_SHARED_PROJECTS_DIR?.trim() || path.join(process.cwd(), ".codex");
const THUMBNAIL_DIR = path.join(THUMBNAIL_ROOT, "project-thumbnails");
const THUMBNAIL_OWNER_DIR = path.join(THUMBNAIL_DIR, ".owners");
const SKETCHFORGE_SESSION_HEADER = "x-sketchforge-session";
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
const MAX_THUMBNAIL_REQUEST_BYTES = Math.ceil((MAX_THUMBNAIL_BYTES * 4) / 3) + PNG_DATA_URL_PREFIX.length + 2048;

function safeProjectId(projectId: string) {
  const clean = projectId.replace(/[^a-zA-Z0-9_-]/g, "");
  return clean || null;
}

function thumbnailPath(projectId: string) {
  const safeId = safeProjectId(projectId);
  if (!safeId) {
    return null;
  }
  return path.join(THUMBNAIL_DIR, `${safeId}.png`);
}

function thumbnailOwnerPath(projectId: string) {
  const safeId = safeProjectId(projectId);
  return safeId ? path.join(THUMBNAIL_OWNER_DIR, `${safeId}.owner`) : null;
}

function authenticatedSessionId(request: Request) {
  const sessionId = request.headers.get(SKETCHFORGE_SESSION_HEADER)?.trim();
  return sessionId && sessionId.length <= 128 ? sessionId : null;
}

async function readThumbnailOwner(projectId: string) {
  const ownerPath = thumbnailOwnerPath(projectId);
  if (!ownerPath) return null;
  try {
    return await fs.readFile(ownerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function claimThumbnailProject(projectId: string, sessionId: string) {
  const ownerPath = thumbnailOwnerPath(projectId);
  if (!ownerPath) return false;
  const existingOwner = await readThumbnailOwner(projectId);
  if (existingOwner !== null) return existingOwner === sessionId;
  await fs.mkdir(THUMBNAIL_OWNER_DIR, { recursive: true });
  try {
    await fs.writeFile(ownerPath, sessionId, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return (await readThumbnailOwner(projectId)) === sessionId;
  }
}

async function canAccessThumbnailProject(request: Request, projectId: string) {
  const sessionId = authenticatedSessionId(request);
  if (!sessionId) return true;
  const owner = await readThumbnailOwner(projectId);
  return owner === null || owner === sessionId;
}

function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const requestUrl = new URL(request.url);
      const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
      const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
      const host = forwardedHost || request.headers.get("host") || requestUrl.host;
      const protocol = (forwardedProtocol || requestUrl.protocol.replace(/:$/, "")).toLowerCase();
      if (protocol !== "http" && protocol !== "https") return false;
      if (new URL(origin).origin !== new URL(`${protocol}://${host}`).origin) return false;
    } catch {
      return false;
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

function decodedBase64ByteLength(value: string) {
  if (value.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

export async function GET(request: Request) {
  if (!isSameOriginRequest(request)) {
    return new NextResponse("Project thumbnails require a same-origin request", { status: 403 });
  }

  const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
  const filePath = thumbnailPath(projectId);
  if (!filePath) {
    return new NextResponse("Invalid project id", { status: 400 });
  }

  try {
    if (!(await canAccessThumbnailProject(request, projectId))) {
      return new NextResponse("Project thumbnail is owned by another SketchForge session", { status: 403 });
    }
    const image = await fs.readFile(filePath);
    return new NextResponse(image, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "image/png",
      },
    });
  } catch {
    return new NextResponse("Thumbnail not found", { status: 404 });
  }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Project thumbnails require a same-origin request" }, { status: 403 });
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_THUMBNAIL_REQUEST_BYTES) {
    return NextResponse.json({ error: "Thumbnail image is too large" }, { status: 413 });
  }

  let body: { dataUrl?: unknown; projectId?: unknown };
  try {
    body = (await request.json()) as { dataUrl?: unknown; projectId?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid thumbnail request" }, { status: 400 });
  }

  try {
    if (typeof body.projectId !== "string" || typeof body.dataUrl !== "string") {
      return NextResponse.json({ error: "Invalid thumbnail request" }, { status: 400 });
    }

    const filePath = thumbnailPath(body.projectId);
    if (!filePath || !body.dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
      return NextResponse.json({ error: "Invalid thumbnail image" }, { status: 400 });
    }

    const encodedImage = body.dataUrl.slice(PNG_DATA_URL_PREFIX.length);
    const decodedBytes = decodedBase64ByteLength(encodedImage);
    if (decodedBytes === null) {
      return NextResponse.json({ error: "Invalid thumbnail image" }, { status: 400 });
    }
    if (decodedBytes > MAX_THUMBNAIL_BYTES) {
      return NextResponse.json({ error: "Thumbnail image is too large" }, { status: 413 });
    }

    const sessionId = authenticatedSessionId(request);
    if (sessionId && !(await claimThumbnailProject(body.projectId, sessionId))) {
      return NextResponse.json({ error: "Project thumbnail is owned by another SketchForge session" }, { status: 403 });
    }

    await fs.mkdir(THUMBNAIL_DIR, { recursive: true });
    await fs.rm(filePath, { force: true });
    await fs.writeFile(filePath, Buffer.from(encodedImage, "base64"));

    return NextResponse.json({ version: Date.now() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save thumbnail" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Project thumbnails require a same-origin request" }, { status: 403 });
  }

  const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
  const filePath = thumbnailPath(projectId);
  if (!filePath) {
    return NextResponse.json({ error: "Invalid project id" }, { status: 400 });
  }
  if (!(await canAccessThumbnailProject(request, projectId))) {
    return NextResponse.json({ error: "Project thumbnail is owned by another SketchForge session" }, { status: 403 });
  }

  await fs.rm(filePath, { force: true });
  return NextResponse.json({ deleted: true });
}
