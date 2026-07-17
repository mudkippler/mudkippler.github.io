# Project Manual

This document provides an overview of the multiplayer-shmup project, its structure, and key concepts.

## Overview

This project is a multiplayer top-down shooter game, similar to games like Touhou. It's built with HTML, CSS, and JavaScript, using WebSockets for multiplayer functionality. The game is designed to be modular and extensible, with a focus on human-readable code.

## Project Structure

The project is divided into two main parts: the client-side code in the `public` directory and the server-side code in the `server` directory.

### Client-Side (`public/`)

The client-side code is responsible for rendering the game, handling user input, and communicating with the server.

-   `index.html`: The main HTML file for the game.
-   `client.js`: The main entry point for the client-side JavaScript. It handles the WebSocket connection, game loop, and local simulation.
-   `renderer.js`: Responsible for drawing the game state onto the canvas.
-   `attacks.js`: Defines the boss attack patterns, which are simulated locally on each client.
-   `mechanics.js`: Implements the client-side logic for boss mechanics.
-   `hud.js`: Manages the player's heads-up display (HUD), showing health and other information.
-   `bossbar.js`: Controls the boss's health bar and other UI elements related to the boss.
-   `bossportrait.js`: Manages the boss's portrait and dialogue.
-   `leaderboard.js`: Displays the leaderboard with player damage statistics.
-   `diagnostics.js`: Shows network diagnostic information.

### Server-Side (`server/`)

The server-side code manages the game state, player connections, and the overall game logic.

-   `server.js`: The main entry point for the server. It handles WebSocket connections, player management, and the main game loop.
-   `encounters.js`: Defines the boss encounters, including their phases and attack patterns.
-   `phases.js`: Implements the phase engine, which controls the flow of boss encounters.
-   `utils.js`: Contains utility functions used by the server.

## Core Concepts

### Client-Side Simulation

To minimize latency and optimize for bandwidth, the game uses a client-side simulation model. Each client simulates its own bullets and boss attacks locally. The server is only authoritative for player positions, health, and the shared boss health. When a client's local simulation lands a hit, it reports the damage to the server.

### Encounters and Phases

Boss fights are defined as "encounters" in `server/encounters.js`. Each encounter is a series of "phases," each with its own set of mechanics, attack patterns, and boss behaviors. The phase engine on the server (`server/phases.js`) manages the progression through these phases.

### Boss Art (Sprites and Portraits)

Boss art is convention-based: drop correctly named PNGs into `public/img/` and they're picked up automatically — no code changes needed.

There are two kinds of art, keyed by the encounter's `id` from `server/encounters.js` (e.g. `bombardment`, `twin`):

-   **Sprite** (`<encounterId>_sprite.png`): the boss's in-arena body, drawn on the canvas in place of the plain circle (see `bossSpriteFor` in `public/renderer.js`). It's stretched to the boss's diameter (`boss.radius * 2`), so use square images with transparency. The radius comes from the encounter's optional `bossRadius` field in `server/encounters.js` (default `DEFAULT_BOSS_RADIUS`); it drives the drawn size **and** the hitbox player bullets test against, so sizing a boss up also makes it a bigger target.
-   **Portrait** (`<encounterId>.png`): the dialogue portrait shown next to boss lines (see `public/bossportrait.js`).

Both support optional per-state variants named `<encounterId>_<state>_sprite.png` / `<encounterId>_<state>.png`. The state comes from `bossPortraitState`: `base` (no suffix) above 50% HP, `injured` below, or whatever a phase pins via its `portrait` field in `server/encounters.js` (e.g. `enraged`, `defeat`, twin's `sun`/`moon`/`eclipse`).

Fallback order for sprites: state-specific sprite → base sprite → plain tinted circle. So a single `<encounterId>_sprite.png` covers the whole fight (this is how `bombardment_sprite.png` works), and you can add state variants later to override specific moments (this is how twin's `sun`/`moon`/`eclipse` sprites work). Portraits don't fall back — a missing portrait file just hides the portrait image.

### Bandwidth Optimization

The game uses MessagePack for data serialization to reduce bandwidth usage. This is controlled by the `USE_MSGPACK_COMPRESSION` constant in both `client.js` and `server.js`.

## Getting Started

To run the game, you need to have Node.js installed.

1.  Install the dependencies:
    ```
    npm install
    ```
2.  Start the server:
    ```
    node server/server.js
    ```
3.  Open your web browser and navigate to `http://localhost:3000`.
