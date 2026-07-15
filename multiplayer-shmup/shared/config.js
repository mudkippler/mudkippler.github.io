// Shared configuration for client and server

// Game mechanics
export const TICK_RATE = 20;
export const PLAYER_SPEED_PER_SEC = 150;
export const PLAYER_BULLET_SPEED = 5;
export const BULLET_DAMAGE = 10;
export const PLAYER_DAMAGE_BY_SOURCE = {
  bullet: BULLET_DAMAGE,
  missile: 35,
  lightning: 25,
  star: 25,
  ray: 12,
  flare: 15,
  laser: 20,
  beam: 18,
  moonbeam: 10,
  dark: 1
};
export const WIND_MAX_STRENGTH = 120;
export const UMBRELLA_BLOWN_GUST = 0.55;
export const PLAYER_SHOT_COOLDOWN = 200; // ms
export const ORB_RADIUS = 18;

// Networking
export const USE_MSGPACK_COMPRESSION = true;
export const INTERPOLATION_DELAY = 50; // milliseconds
export const DAMAGE_REPORT_MIN_INTERVAL = 50; // ms
export const CHAT_MIN_INTERVAL = 500; // ms
export const SHOT_RELAY_MIN_INTERVAL = 150; // ms

// Player
export const PLAYER_RADIUS = 10;
export const ALLY_ALPHA = 0.75;
export const RECONCILE_SNAP = 80; // px
export const REVIVE_RADIUS = 30; // px
export const REVIVE_TIME = 3000; // ms
export const REVIVE_DECAY_MULTIPLIER = 0.4;
export const REVIVE_HEALTH = 50;
export const NAME_MAX_LENGTH = 16;
export const CHAT_MAX_LENGTH = 200;

// Lobby
export const TEAM_WIPE_RESET_DELAY = 4000; // ms
export const GRAVE_LIMIT = 50;
export const LOBBY_MAX_PLAYERS = 10;
export const EMPTY_LOBBY_TTL = 30000; // ms
export const PLAYER_COLORS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9a6324', '#fffac8', '#800000', '#aaffc3',
  '#ffd8b1', '#ff6347', '#7fffd4', '#ff69b4', '#1e90ff'
];
