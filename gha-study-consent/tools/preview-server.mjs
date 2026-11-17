// Local preview: serves the site and replaces the Apps Script endpoint with a mock.
// Usage (from tools/): node preview-server.mjs   then open http://localhost:8080
// Signed PDFs received by the mock are written to tools/preview-output/ (git-ignored).
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT = fileURLToPath(new URL("./preview-output/", import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const MOCK_PATH = "/mock-exec";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".pdf": "application/pdf",
};

let issued = 0;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "POST" && url.pathname === MOCK_PATH) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const pdf = Buffer.from(body.pdfBase64, "base64");
    const token = `SPK-TEST${String(++issued).padStart(4, "2")}`;
    await mkdir(OUTPUT, { recursive: true });
    await writeFile(join(OUTPUT, `${token}.pdf`), pdf);
    console.log(`Mock: ${token}, ${pdf.length} bytes, version ${body.consentVersion}, signed ${body.signedAt}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, token, url: `https://example.org/survey?token=${token}` }));
    return;
  }

  const path = normalize(join(ROOT, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
  if (!path.startsWith(ROOT)) return void res.writeHead(403).end();
  try {
    let data = await readFile(path);
    if (path.endsWith(join("assets", "app.js"))) {
      data = data.toString("utf8").replace(/endpoint: "[^"]*"/, `endpoint: "${MOCK_PATH}"`);
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(PORT, () => console.log(`Preview with mock backend: http://localhost:${PORT}`));
