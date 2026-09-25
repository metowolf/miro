import assert from "node:assert/strict";
import test from "node:test";

import { isSynchronizedOutputSupported } from "./term-caps.js";

test("tmux always disables DEC 2026 even when the outer terminal is known to support it", () => {
  assert.equal(isSynchronizedOutputSupported({ TMUX: "", TERM_PROGRAM: "WezTerm" }), false);
});

test("a known TERM_PROGRAM supports DEC 2026", () => {
  for (const termProgram of [
    "iTerm.app",
    "WezTerm",
    "WarpTerminal",
    "ghostty",
    "contour",
    "vscode",
    "alacritty",
  ]) {
    assert.equal(isSynchronizedOutputSupported({ TERM_PROGRAM: termProgram }), true, termProgram);
  }
});

test("kitty, Ghostty, foot, and Alacritty TERM variants support DEC 2026", () => {
  for (const term of ["xterm-kitty", "screen-kitty", "xterm-ghostty", "foot", "foot-extra", "xterm-alacritty"]) {
    assert.equal(isSynchronizedOutputSupported({ TERM: term }), true, term);
  }
});

test("terminal-specific environment variables support DEC 2026", () => {
  for (const environment of [
    { KITTY_WINDOW_ID: "1" },
    { ZED_TERM: "1" },
    { WT_SESSION: "session-id" },
  ]) {
    assert.equal(isSynchronizedOutputSupported(environment), true);
  }
});

test("VTE 0.68 and above supports DEC 2026", () => {
  assert.equal(isSynchronizedOutputSupported({ VTE_VERSION: "6800" }), true);
  assert.equal(isSynchronizedOutputSupported({ VTE_VERSION: "7200" }), true);
});

test("older or invalid VTE versions and unknown terminals stay conservatively disabled", () => {
  assert.equal(isSynchronizedOutputSupported({ VTE_VERSION: "6799" }), false);
  assert.equal(isSynchronizedOutputSupported({ VTE_VERSION: "unknown" }), false);
  assert.equal(isSynchronizedOutputSupported({ TERM_PROGRAM: "xterm" }), false);
  assert.equal(isSynchronizedOutputSupported({}), false);
});
