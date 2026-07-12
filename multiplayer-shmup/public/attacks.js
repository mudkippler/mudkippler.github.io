// Boss attack patterns, simulated locally on each client.
// These are cosmetic/local only — the server does not know about boss bullets,
// it only tracks boss HP. Each client reports damage it lands on/takes from the boss.

let bulletIdCounter = 0;

export function circularAttack(boss, bossBullets, angleOffset) {
    const BULLET_VELOCITY = 1;
    const numberOfAngles = 4;

    const angleIncrement = Math.PI * 2 / numberOfAngles;
    for (let i = 0; i < numberOfAngles; i++) {
        const angle = i * angleIncrement;
        bossBullets.push({
            id: bulletIdCounter++,
            x: boss.x,
            y: boss.y,
            dx: Math.cos(angle + angleOffset) * BULLET_VELOCITY,
            dy: Math.sin(angle + angleOffset) * BULLET_VELOCITY,
            type: 1, // 1 for circular
            size: 6
        });
    }
}

export function bigRedBallAttack(boss, bossBullets) {
    bossBullets.push({
        id: bulletIdCounter++,
        x: boss.x,
        y: boss.y,
        dx: (Math.random() - 0.5) * 10,
        dy: (Math.random() - 0.5) * 10,
        type: 2, // 2 for bigRedBall
        size: 20
    });
}
