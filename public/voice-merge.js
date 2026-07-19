// BREWDECK voice transcript merging.
//
// Android's SpeechRecognition doesn't emit clean, disjoint final segments.
// Depending on device/version it does any of:
//   a) re-deliver the SAME result index with a fuller restatement
//   b) deliver each fuller restatement at a NEW index ("made there",
//      "made there is", "made there is no", …) — naive joining turns a
//      one-line order into a quadratic wall of repeated prefixes
//   c) restate across a session boundary (silence gap respawns the session)
// Desktop Chrome, meanwhile, sends genuinely disjoint segments that must be
// concatenated. This module reconciles all of it:
//   - a restatement that extends the previous segment REPLACES it
//   - a stale shorter repeat is dropped
//   - overlapping tail/head (≥2 words) is stitched without duplication
//   - anything genuinely new is appended
//
// Loaded by the app as window.VoiceMerge and by scripts/test-voice.mjs in
// node (globalThis.VoiceMerge) — dependency-free, environment-agnostic.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module !== null && module.exports) module.exports = api;
  else root.VoiceMerge = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // normalized word list — casing/punctuation never count as a difference
  const tok = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/)
      .filter(Boolean);

  // true when `shorter`'s words are exactly the opening words of `longer`
  function extendsWords(shorter, longer) {
    const A = tok(shorter), B = tok(longer);
    if (A.length > B.length) return false;
    return A.every((w, i) => w === B[i]);
  }

  // stitch "…can see my" + "see my previous…" → "…can see my previous…";
  // needs ≥2 overlapping words so a lone "the"/"a" never causes a false join.
  // Returns null when there is no confident overlap.
  function overlapMerge(a, b) {
    const A = String(a).split(/\s+/).filter(Boolean);
    const B = String(b).split(/\s+/).filter(Boolean);
    const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const maxK = Math.min(A.length, B.length);
    for (let k = maxK; k >= 2; k--) {
      let ok = true;
      for (let j = 0; j < k; j++) {
        if (norm(A[A.length - k + j]) !== norm(B[j])) {
          ok = false;
          break;
        }
      }
      if (ok) return A.concat(B.slice(k)).join(" ");
    }
    return null;
  }

  // merge one chunk into an accumulated transcript (used across session
  // boundaries, where the new session may restate the committed tail)
  function mergeFinal(acc, chunk) {
    chunk = String(chunk || "").trim();
    const a = String(acc || "").trim();
    if (!chunk) return a;
    if (!a) return chunk;
    if (extendsWords(a, chunk)) return chunk; // fuller restatement of everything
    if (extendsWords(chunk, a)) return a; // stale repeat, keep what we have
    return overlapMerge(a, chunk) || a + " " + chunk;
  }

  // fold one session's index-keyed finals into a transcript. Each incoming
  // final is compared against the LAST kept segment — that's what defeats the
  // new-index-per-restatement stream: the growing prefix chain keeps
  // replacing its predecessor instead of piling up next to it.
  function foldSegs(segs) {
    const merged = [];
    for (const raw of segs) {
      const s = String(raw || "").trim();
      if (!s) continue;
      const last = merged[merged.length - 1];
      if (last === undefined) {
        merged.push(s);
      } else if (extendsWords(last, s)) {
        merged[merged.length - 1] = s; // restatement grew — replace
      } else if (extendsWords(s, last)) {
        /* stale shorter repeat — drop */
      } else {
        const om = overlapMerge(last, s);
        if (om) merged[merged.length - 1] = om;
        else merged.push(s); // genuinely new content
      }
    }
    return merged.join(" ");
  }

  return { tok, extendsWords, overlapMerge, mergeFinal, foldSegs };
});
