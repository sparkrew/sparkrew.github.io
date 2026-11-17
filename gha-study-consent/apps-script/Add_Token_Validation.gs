/**
 * One-time: requires the assignment-token answer in all six forms to match TOKEN_PATTERN.
 * Catches accidental edits; deliberate changes are caught later by checkTokens().
 * Needs FORMS[variant].editId for every variant.
 */
function addTokenValidation() {
  const validation = FormApp.createTextValidation()
    .requireTextMatchesPattern(TOKEN_PATTERN)
    .setHelpText("Please keep the prefilled assignment token exactly as provided.")
    .build();

  for (const variant of VARIANTS) {
    const config = FORMS[variant];
    if (!config || !config.editId) throw new Error(`FormConfig editId missing for ${variant}`);
    const form = FormApp.openById(config.editId);
    const item = tokenItem_(form, variant);
    item.setValidation(validation).setRequired(true);
    if (!item.getHelpText()) item.setHelpText("Filled in automatically. Please do not edit.");
    console.log(`${variant}: validation set on "${item.getTitle()}" (${form.getTitle()})`);
  }
}

/** Read-only check that each configured form matches its variant and prefill entry ID. */
function verifyFormConfig() {
  for (const variant of VARIANTS) {
    const config = FORMS[variant];
    const form = FormApp.openById(config.editId);
    const item = tokenItem_(form, variant);
    const prefill = item.createResponse("SPK-TEST2345");
    const url = form.createResponse().withItemResponse(prefill).toPrefilledUrl();
    const entryOk = url.indexOf(`entry.${config.entryId}=`) >= 0;
    const publishedOk = form.getPublishedUrl().indexOf(config.publishedId) >= 0;
    const titleOk = form.getTitle().indexOf(variant) >= 0;
    console.log(`${variant}: title ${titleOk ? "ok" : "MISMATCH"}, published id ${publishedOk ? "ok" : "MISMATCH"}, ` +
      `entry id ${entryOk ? "ok" : "MISMATCH"}, accepting responses: ${form.isAcceptingResponses()}`);
  }
}

function tokenItem_(form, variant) {
  const item = form.getItems(FormApp.ItemType.TEXT)
    .find((candidate) => candidate.getTitle().indexOf(TOKEN_ITEM_PREFIX) === 0);
  if (!item) throw new Error(`No "${TOKEN_ITEM_PREFIX}" question in form ${variant}`);
  return item.asTextItem();
}
