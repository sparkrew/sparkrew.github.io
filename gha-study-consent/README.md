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

## Before launch (non-code)

These must be settled first. The protocol says not to collect data before approval.

1. **Protocol and consent wording.** The consent form says participants return the PDF by email, and that
   "after your consent has been checked, the researchers will provide your assignment token". The site
   issues the token immediately, without a manual check. Update the consent text and protocol sections 2 and 4
   to describe the website, and confirm the change with Prof. Arawjo.
2. **Participant-rights contact.** Replace "[ethics committee contact to be added before recruitment]" in the
   protocol, then rebuild `assets/consent.pdf` (see below) and bump `consentVersion` in `assets/app.js`.
3. **Signature type.** The drawn signature is an electronic signature, not a cryptographic digital signature.
   Confirm that this satisfies "digitally signed and dated".
4. **Google processing.** The signed PDF passes through Google Apps Script and the sending account's Gmail
   (in its Sent folder). Delete the sent copies once the PDFs are stored in OneDrive.
5. **Forms.** Remove "DRAFT" from the six form titles, turn off "Collect email addresses", and open them for
   responses.

## Setup

### 1. Apps Script back end

1. Create a new Google Sheet (e.g. "SPARK allocation", private), then **Extensions → Apps Script**.
2. In the editor, enable **Project Settings → Show "appsscript.json" manifest file**, and paste in:
   `appsscript.json`, `Code.gs`, `Add_Token_Validation.gs`, and `FormConfig.gs`.
   Do **not** paste `FormConfig.example.gs`, because it would define `FORMS` twice.
3. In `FormConfig.gs`, fill in `editId` for each form. It is the ID in the editor URL
   `https://docs.google.com/forms/d/<editId>/edit`. `publishedId` and `entryId` are already filled in.
4. Run `verifyFormConfig` and check the log: every variant should report `ok` three times.
5. Run `setupAllocation` **once**. It creates the `Allocation` sheet (180 slots, random tokens) and a `Meta`
   sheet with the shuffle seed and a SHA-256 hash of the sequence for the protocol record. It refuses to run
   again once the sheet exists.
6. Run `addTokenValidation` to make the token question require the `SPK-XXXXXXXX` format in all six forms.
7. **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Anyone**. Copy the URL
   ending in `/exec`.

The emails come from the deploying Google account. A consumer Gmail account can send to about 100
recipients per day, which is about 50 participants per day, since each email goes to two researchers.

### 2. Website on GitHub Pages

1. Paste the web app URL into `CONFIG.endpoint` at the top of `assets/app.js`.
2. Create a GitHub repository and push this folder. `.gitignore` already excludes `Study_Protocol.pdf`, which
   contains answer keys, and `apps-script/FormConfig.gs`, which contains the direct survey links.
3. **Settings → Pages → Deploy from a branch → `main` / root**. The site appears at
   `https://<user>.github.io/<repo>/`.

Free GitHub Pages sites come from public repositories, so anyone can read the code. The direct form links
and the allocation sequence stay private in Apps Script and the spreadsheet.

### 3. End-to-end test

1. Submit the consent on desktop and on a phone. Check that each researcher receives one email with the
   correct PDF, token, and variant, and that the form opens with the token filled in.
2. Reload the site; it should show the same token rather than issuing a new one. Use a private window to
   simulate another participant.
3. Submit a test response in the form, run `checkTokens`, and check the `TokenCheck` sheet. Also try a token
   in the wrong format to confirm that the form validation rejects it.
4. In the `Allocation` sheet, change the status of every test slot from `issued`/`completed` to `test`.
   Do not delete rows: slots are never reused. Delete the test responses from the forms.

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
