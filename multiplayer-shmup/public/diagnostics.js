const diagnostics = document.getElementById('diagnostics');
let receivedBytes = 0;
let sentBytes = 0;
let lastCheck = Date.now();

export function updateDiagnostics() {
    const now = Date.now();
    const elapsed = (now - lastCheck) / 1000; // seconds
    if (elapsed > 1) {
        const receivedBps = receivedBytes / elapsed;
        const sentBps = sentBytes / elapsed;

        diagnostics.innerHTML = `
            <div>Down: ${(receivedBps / 1024).toFixed(2)} KB/s</div>
            <div>Up: ${(sentBps / 1024).toFixed(2)} KB/s</div>
        `;

        receivedBytes = 0;
        sentBytes = 0;
        lastCheck = now;
    }
}

export function addReceivedBytes(bytes) {
    receivedBytes += bytes;
}

export function addSentBytes(bytes) {
    sentBytes += bytes;
}