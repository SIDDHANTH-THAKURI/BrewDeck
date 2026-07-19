// Voice-merge unit tests — every SpeechRecognition delivery pattern we've
// seen in the wild, including the exact "growing prefix chain at new
// indexes" storm that turned a one-line spoken order into a wall of
// repeated text.  node scripts/test-voice.mjs

await import("../public/voice-merge.js");
const { mergeFinal, foldSegs } = globalThis.VoiceMerge;

let failures = 0;
function eq(name, got, want) {
  if (got === want) console.log("ok  -", name);
  else {
    failures++;
    console.error("FAIL-", name, "\n  got: ", JSON.stringify(got), "\n  want:", JSON.stringify(want));
  }
}

// 1. Android storm: each fuller restatement arrives at a NEW index
//    (the bug from the field: "made there", "made there is", …)
{
  const sentence = "there is no option for new chat or something because I can see my previous conversation";
  const words = sentence.split(" ");
  const segs = ["in this current"];
  for (let i = 1; i <= words.length; i++) segs.push(words.slice(0, i).join(" "));
  eq("android new-index restatement storm", foldSegs(segs), "in this current " + sentence);
}

// 2. Same-index cumulative restatement (index-keyed overwrite upstream means
//    the array just holds the final value — must pass through unchanged)
eq("same-index restatement", foldSegs(["add a pause menu to the game"]), "add a pause menu to the game");

// 3. Desktop-style disjoint segments concatenate
eq("disjoint segments", foldSegs(["add a pause menu", "and run the build"]), "add a pause menu and run the build");

// 4. Stale shorter repeat is dropped
eq("stale repeat dropped", foldSegs(["fix the login bug", "fix the login"]), "fix the login bug");

// 5. Overlapping tail/head stitches without duplication (≥2 words)
eq(
  "overlap stitch",
  foldSegs(["because I can see my", "see my previous conversation"]),
  "because I can see my previous conversation"
);

// 6. One-word overlap must NOT stitch (too risky) — genuinely new content appends
eq("no false one-word stitch", foldSegs(["open the file", "the tests too"]), "open the file the tests too");

// 7. Legit repeated words inside one final survive
eq("legit repeats survive", foldSegs(["this is really really important"]), "this is really really important");

// 8. Cross-session boundary: new session restates everything committed so far
eq(
  "cross-session full restatement",
  mergeFinal("add a pause menu", "add a pause menu and save the game"),
  "add a pause menu and save the game"
);

// 9. Cross-session boundary: tail overlap
eq(
  "cross-session tail overlap",
  mergeFinal("run the tests and fix", "and fix whatever breaks"),
  "run the tests and fix whatever breaks"
);

// 10. Cross-session boundary: genuinely new content appends
eq("cross-session new content", mergeFinal("first do this", "then do that"), "first do this then do that");

// 11. Punctuation/case differences don't defeat restatement detection
eq("case/punctuation insensitive", foldSegs(["Fix the bug.", "fix the bug in login"]), "fix the bug in login");

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nALL VOICE-MERGE TESTS PASS");
