# SPARK consent and assignment website

Participants open the site, read the survey consent form (Appendix B of the protocol), and sign it in the
browser. The signed PDF is emailed to Alireza and Madjda together with a new assignment token. The
participant is then sent to one of the six Google Forms (A1–B3) with the token prefilled.

- **Front end** (`index.html`, `assets/`): static files hosted on GitHub Pages. It stores nothing except the
  participant's own token in their browser (`localStorage`), so reopening the site shows the same assignment.
- **Back end** (`apps-script/`): a Google Apps Script web app bound to a private allocation spreadsheet. It
  emails the PDF (without saving it to Drive) and hands out slots from a pre-randomized sequence of 30 blocks.
  Each block contains each of the six variants once, so the groups are exactly equal after every complete
  block of six participants.

```
index.html, assets/          public website (GitHub Pages)
assets/consent.pdf           Appendix B, pages 14-15 of the protocol, researcher note hidden
apps-script/Code.gs          doPost, setupAllocation, checkTokens
apps-script/Add_Token_Validation.gs   addTokenValidation, verifyFormConfig
apps-script/FormConfig.gs    PRIVATE direct survey links (git-ignored)
tools/                       consent extraction and local preview (not needed in production)
```
## Running the study

- **Allocation statuses:** empty (unused), `issued`, `completed`, `abandoned` (issued more than 7 days ago
  with no response), and `test`. You can also set `void` manually; any non-empty status is never handed out again.
- **Weekly check:** run `checkTokens` (or add a weekly time-driven trigger). It updates statuses and lists
  every response in `TokenCheck` as `OK`, `INVALID: unknown token`, `MISMATCH: token issued for …`, or
  `DUPLICATE` (later submissions; the earliest is kept). These correspond to protocol exclusions 5 and 7.
- **Token edits:** Google Forms cannot lock a prefilled field. The format validation catches accidental edits,
  and `checkTokens` catches deliberate ones. Tokens are random, so a changed token almost never matches a
  real one, and a token copied from another participant fails the variant check.
- **Identity linkage:** each email (token + signed PDF) is the consent-to-token record. Store the PDFs in the
  restricted OneDrive folder and the mapping in the restricted linkage file, as the protocol describes.
- **If the email fails,** the participant sees an error, gets no survey link, and the slot is returned to the
  sequence.
- **Stopping:** when the study closes, set the web app's access to "Only myself" or archive the deployment;
  the site then shows a submission error.

## Updating the consent PDF

```
cd tools
npm install
npm run extract-consent    # rebuilds assets/consent.pdf from ../Study_Protocol.pdf
npm run preview            # http://localhost:8080 with a mock back end; PDFs land in tools/preview-output/
```

`extract-consent.mjs` assumes Appendix B is on physical pages 14–15. If the protocol layout changes, adjust
`PAGE_INDICES` and the hidden researcher-note rectangle. The site finds the "Participant name:", "Digital
signature:", and "Date:" labels automatically.
