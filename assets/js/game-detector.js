// 360 Desktop — game process detector
// Polls the OS process list on an interval and checks running process
// names against a curated list of common game executables. No external
// npm dependency (no ps-list/ps-node) — just the platform's own process-
// listing command via child_process, parsed manually. Cross-platform:
// Windows (tasklist), macOS/Linux (ps).

const { exec } = require("child_process");

// Known game process names (lowercase, without .exe on non-Windows).
// This is necessarily a curated, incomplete list — there's no OS API for
// "is this process a game," so detection is inherently pattern-matching
// against known launchers/engines/titles. Extend freely.
const KNOWN_GAME_PROCESSES = [
  // Launchers (a launcher running is a strong "about to game" / "gaming" signal)
  "steam.exe", "steamwebhelper.exe", "epicgameslauncher.exe", "battle.net.exe",
  "riotclientservices.exe", "leagueclient.exe", "origin.exe", "eadesktop.exe",
  "galaxyclient.exe", "ubisoftconnect.exe", "upc.exe",
  // Popular individual titles
  "valorant.exe", "valorant-win64-shipping.exe",
  "csgo.exe", "cs2.exe",
  "fortniteclient-win64-shipping.exe",
  "minecraft.exe", "javaw.exe", // javaw is broad (any Java app) — treated as low-confidence, see CONFIDENCE map
  "robloxplayerbeta.exe",
  "gta5.exe", "gtav.exe",
  "overwatch.exe",
  "apex_legends.exe", "r5apex.exe",
  "destiny2.exe",
  "eldenring.exe",
  "cyberpunk2077.exe",
  "rocketleague.exe",
  "dota2.exe",
  "warzone.exe", "modernwarfare.exe",
  "wow.exe", "wowclassic.exe",
  "terraria.exe",
  "amongus.exe",
  "rust.exe",
  "palworld.exe", "palworld-win64-shipping.exe",
];

// Processes that are common but ambiguous (could be the game, could be
// something unrelated with the same executable name) — still reported,
// but callers may want to weight these lower.
const LOW_CONFIDENCE = new Set(["javaw.exe"]);

function normalize(name) {
  return name.trim().toLowerCase();
}

function listProcessesWindows() {
  return new Promise((resolve) => {
    exec("tasklist /FO CSV /NH", { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const names = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => {
          const m = line.match(/^"([^"]+)"/);
          return m ? normalize(m[1]) : null;
        })
        .filter(Boolean);
      resolve(names);
    });
  });
}

function listProcessesUnix() {
  return new Promise((resolve) => {
    exec("ps -A -o comm=", (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const names = stdout
        .split(/\r?\n/)
        .map(line => normalize(line.split("/").pop() || ""))
        .filter(Boolean);
      resolve(names);
    });
  });
}

async function listProcesses() {
  return process.platform === "win32" ? listProcessesWindows() : listProcessesUnix();
}

function matchGame(processNames) {
  const nameSet = new Set(processNames);
  for (const known of KNOWN_GAME_PROCESSES) {
    // On macOS/Linux there's no ".exe" — strip it for the comparison so
    // the same list works cross-platform without duplicating entries.
    const bare = known.replace(/\.exe$/, "");
    if (nameSet.has(known) || nameSet.has(bare)) {
      return { process: known, confidence: LOW_CONFIDENCE.has(known) ? "low" : "high" };
    }
  }
  return null;
}

let pollTimer = null;
let currentlyDetected = null;

function startGameDetector({ onGameStart, onGameEnd, pollIntervalMs = 5000 }) {
  stopGameDetector(); // guard against double-start
  pollTimer = setInterval(async () => {
    try {
      const procs = await listProcesses();
      const match = matchGame(procs);

      if (match && !currentlyDetected) {
        currentlyDetected = match.process;
        onGameStart && onGameStart(prettyName(match.process));
      } else if (!match && currentlyDetected) {
        currentlyDetected = null;
        onGameEnd && onGameEnd();
      }
    } catch (e) {
      console.error("[game-detector] poll failed:", e.message);
    }
  }, pollIntervalMs);
}

function stopGameDetector() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  currentlyDetected = null;
}

function prettyName(processName) {
  return processName
    .replace(/\.exe$/, "")
    .replace(/-win64-shipping$/, "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = { startGameDetector, stopGameDetector, listProcesses, matchGame, KNOWN_GAME_PROCESSES };
