const API_HOST = window.ENV.API_HOST;
const CAMPUS_BOUNDS = {
    minLat: 35.384,
    minLng: 139.424,
    maxLat: 35.393,
    maxLng: 139.433,
};

function randomCampusCoords() {
    const lat = CAMPUS_BOUNDS.minLat + Math.random() * (CAMPUS_BOUNDS.maxLat - CAMPUS_BOUNDS.minLat);
    const lng = CAMPUS_BOUNDS.minLng + Math.random() * (CAMPUS_BOUNDS.maxLng - CAMPUS_BOUNDS.minLng);
    return [Number(lat.toFixed(7)), Number(lng.toFixed(7))];
}

function resolveTestCoords() {
    const latitude = localStorage.getItem('latitude');
    const longitude = localStorage.getItem('longitude');
    const isOutsideCampus = localStorage.getItem('is_outside_campus') === 'true';

    if (!latitude || !longitude) {
        return null;
    }

    if (isOutsideCampus) {
        const [demoLat, demoLng] = randomCampusCoords();
        return {
            latitude: String(demoLat),
            longitude: String(demoLng),
            mode: 'demo',
        };
    }

    return {
        latitude,
        longitude,
        mode: 'live',
    };
}

async function measureLatency() {
    const t1 = Date.now();
    
    const mockPayload = {
        coords: [1.0, 1.0], 
        signal: 3.0,
        signal_strength: 3.0,
        ping_ms: 1.0
    };
    
    const response = await fetch(`${API_HOST}/api/measurements`, { 
        method:  'POST',
        cache: 'no-store', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mockPayload) 
    });
        
    const ping_ms = Date.now() - t1;     
    return ping_ms;
}

async function sendLatency(latitude, longitude, accuracy, ping_ms) {
    const parsedLat = parseFloat(latitude);
    const parsedLon = parseFloat(longitude);
    const parsedPing = parseFloat(ping_ms);
    const rawAccuracy = parseFloat(accuracy);
    
    let signalScore = 3.0; // Wasn't too sure what signal meant, will update later
    
    const info = {
        coords: [parsedLat, parsedLon],
        signal: signalScore,
        signal_strength: signalScore, 
        ping_ms: parsedPing,
    };
 
    const response = await fetch(`${API_HOST}/api/measurements`, {
        method:  'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(info)
    });
 
    return response;
}

async function measureAndSendBandwidth(latitude, longitude, ping_ms, sizeBytes = 4_000_000, timeoutMs = 10_000) {
    // Download-based probe (same idea as fast.com): fetch a large chunk of
    // random bytes and time how long it takes to fully arrive. An upload of
    // a multi-MB JSON body used to be sent here instead, but that measured
    // upload rather than download speed and, in production, silently ran
    // into the reverse proxy's request-body size limit (a 413 with no CORS
    // headers, which browsers surface as an opaque "CORS policy" error).
    // A GET has no request body, so it isn't subject to that limit.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let receivedBytes = 0;
    const t1 = performance.now();

    try {
        const dlResponse = await fetch(`${API_HOST}/api/speedtest/download?size_bytes=${sizeBytes}`, {
            cache: 'no-store',
            signal: controller.signal,
        });

        const reader = dlResponse.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            receivedBytes += value.length;
        }
    } catch (err) {
        // A timeout abort still leaves us a partial, usable sample as long as
        // some bytes came through; anything else (e.g. network failure before
        // any data arrived) should propagate.
        if (err.name !== 'AbortError' || receivedBytes === 0) {
            clearTimeout(timeout);
            throw err;
        }
    } finally {
        clearTimeout(timeout);
    }

    const seconds = (performance.now() - t1) / 1000;
    const mbps = (receivedBytes * 8 / seconds) / 1_000_000;

    // The probe above only measures the download - the server has no way to know
    // the throughput it implies, so `bandwidth` on that row is always 0. Record the
    // computed value as its own measurement so it actually reaches the heatmap.
    const response = await fetch(`${API_HOST}/api/measurements`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            coords: [parseFloat(latitude), parseFloat(longitude)],
            signal: 3.0,
            signal_strength: 3.0,
            ping_ms: parseFloat(ping_ms),
            bandwidth: mbps,
        }),
    });

    return { response, mbps };
}

async function checkNetwork() {

    const button = document.getElementById('button_network');
    const status = document.getElementById('network_status');
    const result = document.getElementById('network_result');

    const resolvedCoords = resolveTestCoords();
    const accuracy = localStorage.getItem('accuracy');

    if (!resolvedCoords) {
        status.textContent = 'Location must be measured first to measure network';
        status.style.color = '#c0392b';
        result.textContent = '';
        return;
    }

    const latitude = resolvedCoords.latitude;
    const longitude = resolvedCoords.longitude;

    button.disabled = true;
    result.textContent = '';
    result.style.color = '#1a1a1a';
    status.style.color = '#555';

    let ping_ms;
    let mbps;

    status.textContent = 'Measuring Latency...';
    try {
        if (resolvedCoords.mode === 'demo') {
            result.textContent = `Demo mode: submitting simulated SFC coords (${latitude}, ${longitude})`;
            result.style.color = '#5f6368';
        }

        ping_ms = await measureLatency();

        const latencyResponse = await sendLatency(latitude, longitude, accuracy, ping_ms);

        if (!latencyResponse.ok) {
            const serverErrText = await latencyResponse.text();
            status.textContent = `Server Internal Error (${latencyResponse.status}).`;
            status.style.color = '#c0392b';
            result.textContent = `DB Error Logs: ${serverErrText}`;
            result.style.color = '#c0392b';
            button.disabled = false;
            return;
        }
    }
    catch (err) {
        status.textContent = 'Latency measurement/POST failed.';
        status.style.color = '#c0392b';
        result.textContent = `Details: ${err.message}`;
        result.style.color = '#c0392b';
        button.disabled = false;
        return;
    }

    status.textContent = 'Measuring Bandwidth...';
    try {
        const { response: bandwidthResponse, mbps: measuredMbps } = await measureAndSendBandwidth(latitude, longitude, ping_ms);
        mbps = measuredMbps;

        if (!bandwidthResponse.ok) {
            const serverErrText = await bandwidthResponse.text();
            status.textContent = `Server Internal Error (${bandwidthResponse.status}).`;
            status.style.color = '#c0392b';
            result.textContent = `DB Error Logs: ${serverErrText}`;
            result.style.color = '#c0392b';
            button.disabled = false;
            return;
        }

        status.textContent = 'Data sent successfully.';
        status.style.color = '#2e7d52';
        result.textContent = `Latency: ${ping_ms} ms | Bandwidth: ${mbps.toFixed(2)} Mbps (HTTP ${bandwidthResponse.status})`;
        result.style.color = '#2e7d52';
    }
    catch (err) {
        status.textContent = 'Bandwidth measurement/POST failed.';
        status.style.color = '#c0392b';
        result.textContent = `Details: ${err.message}`;
        result.style.color = '#c0392b';
    }
    button.disabled = false;
}

document.addEventListener('DOMContentLoaded', () => {
    const networkBtn = document.getElementById('button_network');
    if (networkBtn) {
        networkBtn.addEventListener('click', checkNetwork);
    }
});