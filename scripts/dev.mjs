import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "src");
const buildAssetsDir = path.join(root, ".build", "assets");
const publicDir = path.join(root, "public");
const audioDir = path.join(root, "audio");
const tscCommand = process.platform === "win32" ? "tsc.cmd" : "tsc";
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 5173);

await runTsc(["-p", path.join(root, "tsconfig.json")]);

const watcher = spawn(tscCommand, [
  "-p",
  path.join(root, "tsconfig.json"),
  "--watch",
  "--preserveWatchOutput"
], {
  cwd: root,
  stdio: "inherit"
});

const server = http.createServer(async (request, response) => {
  try {
    const filePath = await resolveRequestPath(request.url || "/");

    if (!filePath) {
      sendText(response, 404, "Not found");
      return;
    }

    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      sendText(response, 404, "Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-store"
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendText(response, 404, "Not found");
      return;
    }

    console.error(error);
    sendText(response, 500, "Internal server error");
  }
});

server.listen(port, host, () => {
  console.log(`Dev server running at http://${host}:${port}`);
});

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
watcher.once("exit", (code) => {
  if (code && code !== 0) {
    process.exitCode = code;
  }
});

function runTsc(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(tscCommand, args, {
      cwd: root,
      stdio: "inherit"
    });

    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`tsc exited with code ${code}`));
    });
  });
}

async function resolveRequestPath(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return null;
  }

  if (pathname === "/") {
    pathname = "/index.html";
  }

  if (pathname === "/index.html") {
    return path.join(sourceDir, "index.html");
  }

  if (pathname === "/assets/styles.css") {
    return path.join(sourceDir, "styles.css");
  }

  if (pathname.startsWith("/assets/")) {
    return safeJoin(buildAssetsDir, pathname.slice("/assets/".length));
  }

  if (pathname.startsWith("/audio/")) {
    return safeJoin(audioDir, pathname.slice("/audio/".length));
  }

  return safeJoin(publicDir, pathname.slice(1));
}

function safeJoin(baseDir, requestPath) {
  const resolved = path.resolve(baseDir, requestPath);
  const relative = path.relative(baseDir, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return resolved;
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".br": "application/octet-stream",
    ".css": "text/css; charset=utf-8",
    ".gz": "application/gzip",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".wav": "audio/wav",
    ".webm": "audio/webm"
  }[extension] || "application/octet-stream";
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(message);
}

function shutdown() {
  watcher.kill("SIGTERM");
  server.close(() => {
    process.exit();
  });
}
