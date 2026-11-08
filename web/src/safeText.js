// Control and bidirectional-format characters in displayed data become visible escapes, so a claim value cannot
// reorder or hide what the reader sees. Newline and tab stay as they are.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;
export const visible = (s) => String(s).replace(HIDDEN, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
