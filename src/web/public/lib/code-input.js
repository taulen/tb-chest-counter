// An account-invite code field (/join and the in-app Add a clan dialog).
// Codes are always 8 characters shown as "ABCD-EFGH", and the server ignores
// case, spaces and dashes (account-invite-repo normalizeCode), so the field
// never makes anyone type the dash: it upper-cases as you type, drops
// anything that isn't a letter or digit, and puts the dash in itself after
// the fourth character. A pasted code in any shape lands the same way.

const CODE_LENGTH = 8;

/** "abcd efgh" / "ABCD-EFGH" / "abcdefgh" → "ABCD-EFGH"; a partial code keeps its shape. */
export function formatInviteCode(value) {
  const raw = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/** Format `input` as the user types or pastes, keeping the caret where they are typing. */
export function wireCodeInput(input) {
  if (!input) return;
  // Room for a pasted "abcd - efgh "; the value itself never exceeds 9.
  input.maxLength = 20;
  const format = () => {
    const caret = input.selectionStart ?? input.value.length;
    const typedBefore = input.value.slice(0, caret).replace(/[^a-z0-9]/gi, '').length;
    const next = formatInviteCode(input.value);
    if (next === input.value) return;
    input.value = next;
    const pos = Math.min(typedBefore, CODE_LENGTH);
    const at = pos > 4 ? pos + 1 : pos;
    try { input.setSelectionRange(at, at); } catch { /* not focused */ }
  };
  input.addEventListener('input', format);
  format();
}
