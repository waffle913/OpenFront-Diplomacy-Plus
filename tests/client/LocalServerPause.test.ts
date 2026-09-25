import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/core/EventBus";
import type { GameStartInfo, ServerMessage } from "../../src/core/Schemas";

vi.mock("../../src/client/Auth", () => ({
  getAuthHeader: vi.fn(async () => "Bearer test-jwt"),
  getPersistentID: vi.fn(() => "123e4567-e89b-12d3-a456-426614174000"),
}));

vi.mock("../../src/client/Api", () => ({
  getApiBase: vi.fn(() => "https://api.test"),
}));

vi.mock("src/client/ClientEnv", () => ({
  ClientEnv: {
    turnIntervalMs: vi.fn(() => 100),
    gitCommit: vi.fn(() => "DEV"),
  },
}));

import { LocalServer } from "../../src/client/LocalServer";

const CLIENT_ID = "abCD1234";

function makeGameStartInfo(): GameStartInfo {
  return {
    gameID: "gameID12",
    lobbyCreatedAt: 1000,
    config: {
      gameMap: "Africa",
      difficulty: "Medium",
      donateGold: false,
      donateTroops: false,
      gameType: "Singleplayer",
      gameMode: "Free For All",
      gameMapSize: "Normal",
      nations: "default",
      bots: 400,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
    },
    players: [
      {
        clientID: CLIENT_ID,
        username: "TestUser",
        clanTag: null,
      },
    ],
  } as GameStartInfo;
}

describe("LocalServer active pause transport", () => {
  it("transmits paused orders immediately and marks them as non-simulation turns", () => {
    vi.useFakeTimers();
    const messages: ServerMessage[] = [];
    const server = new LocalServer({ gameStartInfo: makeGameStartInfo(), playerName: "TestUser" } as any, false, new EventBus());
    server.updateCallback(() => {}, message => { messages.push(message); if (message.type === "turn") server.turnComplete(); });
    try {
      server.start();
      server.onMessage({ type: "intent", intent: { type: "toggle_pause", paused: true } });
      server.onMessage({ type: "intent", intent: { type: "diplomacy_plus", targetID: "countryB", action: "offer_nap" } });
      server.onMessage({ type: "intent", intent: { type: "attack", targetID: "countryB", troops: 100 } });
      const turns = messages.filter(m => m.type === "turn").map(m => m.turn);
      expect(turns).toHaveLength(3);
      expect(turns.every(t => t.actionsOnly)).toBe(true);
      expect(turns[1].intents[0].type).toBe("diplomacy_plus");
      expect(turns[2].intents[0].type).toBe("attack");
      vi.advanceTimersByTime(1000);
      expect(messages.filter(m => m.type === "turn")).toHaveLength(3);
      server.onMessage({ type: "intent", intent: { type: "toggle_pause", paused: false } });
      vi.advanceTimersByTime(110);
      const resumed = messages.filter(m => m.type === "turn").map(m => m.turn);
      expect(resumed[3].actionsOnly).toBe(true);
      expect(resumed[4].actionsOnly).toBeUndefined();
      expect(resumed[4].intents).toHaveLength(0);
    } finally {
      clearInterval((server as any).turnCheckInterval);
      (server as any).stopHeartbeat?.();
      vi.useRealTimers();
    }
  });
});
