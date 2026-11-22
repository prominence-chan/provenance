// Short display names for provenance-core's concrete model ids:
//   kilo/nvidia/nemotron-3-ultra-550b-a55b:free  -> nemotron-3-ultra
//   groq/openai/gpt-oss-120b                     -> gpt-oss-120b (no size word: the size names it)
//   cohere/command-a-plus-05-2026                -> command-a-plus
//   ovh/DeepSeek-V4.1-Flash-1017                 -> deepseek-v4.1-flash
//   gemini-web/auto, chatgpt-web/luna            -> gemini-auto, chatgpt-luna (chat sites keep the site)
// The id keeps the provider (the first segment) and the full name for the modal.

const SIZE = /^(\d+x)?\d+(\.\d+)?[bm]$/; // 550b, 8x7b, 1.5b
const ACTIVE = /^a\d+(\.\d+)?b$/; // a55b (active parameters): always dropped
// A size word already tells variants apart, so the parameter count can go.
const SIZE_WORD =
  /^(ultra|super|nano|mini|micro|flash|lite|pro|max|plus|omni|lightning|turbo|small|medium|large)$/;
const DATE = /^\d{4}$|^\d{2}$/; // 1017, 2026, 05 (trailing only)
const SUFFIX = new Set(["free", "it", "instruct", "preview"]);

export function shortModelName(id: string): string {
  const last = id.split("/").pop() ?? id;
  const parts = last.split(":")[0].toLowerCase().split("-");
  const sized = parts.some((p) => SIZE_WORD.test(p));
  const kept = parts.filter((p) => !ACTIVE.test(p) && !(sized && SIZE.test(p)));
  while (kept.length > 1 && (DATE.test(kept[kept.length - 1]) || SUFFIX.has(kept[kept.length - 1])))
    kept.pop();
  const name = kept.join("-") || last;
  // Chat sites name their models loosely ("auto", "luna"): keep the site unless the name has it.
  const site = /^(.+)-web$/.exec(modelProvider(id))?.[1];
  return site && !name.includes(site) ? `${site}-${name}` : name;
}

/** The provider segment of a catalog id ("kilo/nvidia/x" -> "kilo"); empty for bare names. */
export function modelProvider(id: string): string {
  const i = id.indexOf("/");
  return i === -1 ? "" : id.slice(0, i);
}
