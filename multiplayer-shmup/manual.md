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
