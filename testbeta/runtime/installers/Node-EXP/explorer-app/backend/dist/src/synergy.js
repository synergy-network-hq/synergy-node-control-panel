const RPC_TIMEOUT_MS = Math.max(250, Number(process.env.SYNERGY_RPC_TIMEOUT_MS || 2500));
async function callSingle(endpoint, method, params = []) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: controller.signal,
        });
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`RPC ${method} failed at ${endpoint}: ${reason}`);
    }
    finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        throw new Error(`RPC ${method} failed at ${endpoint}: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json());
    if (payload.error) {
        throw new Error(`RPC ${method} failed at ${endpoint}: ${payload.error.message}`);
    }
    if (payload.result === undefined) {
        throw new Error(`RPC ${method} returned no result from ${endpoint}`);
    }
    return payload.result;
}
export async function rpcCallWithFallback(transport, method, params = []) {
    try {
        return await callSingle(transport.primary, method, params);
    }
    catch (primaryError) {
        if (!transport.fallback) {
            throw primaryError;
        }
        return await callSingle(transport.fallback, method, params);
    }
}
export function normalizeAddress(value) {
    return String(value || '').trim().toLowerCase();
}
export function normalizeTxHash(value) {
    return String(value || '').trim().toLowerCase();
}
export function isSynergyTransactionHash(value) {
    const candidate = normalizeTxHash(value);
    return /^(?:syntxn|synxxn)-[a-f0-9]{64}$/.test(candidate) || /^[a-f0-9]{64}$/.test(candidate);
}
export function isSynergyAddress(value) {
    const candidate = normalizeAddress(value);
    return candidate.length === 41 && /^syn[a-z0-9]+$/.test(candidate);
}
export function isSynergyValidatorAddress(value) {
    const candidate = normalizeAddress(value);
    return candidate.length === 41 && /^synv[1-5]1[a-z0-9]+$/.test(candidate);
}
export function formatTimestampIso(value) {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return new Date(0).toISOString();
    }
    return new Date(numeric * 1000).toISOString();
}
export function asStringNumber(value) {
    if (value === null || value === undefined)
        return null;
    return String(value);
}
