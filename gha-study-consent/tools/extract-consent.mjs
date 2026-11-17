// Builds assets/consent.pdf from Appendix B of Study_Protocol.pdf.
// Usage (from tools/): node extract-consent.mjs
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument, rgb } from "pdf-lib";

const SOURCE = new URL("../Study_Protocol.pdf", import.meta.url);
const TARGET = new URL("../assets/consent.pdf", import.meta.url);

// Physical pages 14-15 hold the participant-facing part of Appendix B.
// The researcher instructions start at the bottom of page 15 and spill onto page 16, which is dropped.
const PAGE_INDICES = [13, 14];
// Researcher-instructions paragraph on page 15, in PDF user space (origin bottom-left).
const RESEARCHER_NOTE = { x: 66, y: 60, width: 480, height: 40 };

const source = await PDFDocument.load(await readFile(SOURCE));
const consent = await PDFDocument.create();
const pages = await consent.copyPages(source, PAGE_INDICES);
pages.forEach((page) => consent.addPage(page));

pages[1].drawRectangle({ ...RESEARCHER_NOTE, color: rgb(1, 1, 1) });

consent.setTitle("SPARK survey consent");
consent.setAuthor("Madjda Fares and Alireza Nasirianfar");
consent.setSubject("Survey consent: How Developers Respond to Changes in GitHub Actions");

await writeFile(TARGET, await consent.save());
console.log(`Wrote ${TARGET.pathname}`);
