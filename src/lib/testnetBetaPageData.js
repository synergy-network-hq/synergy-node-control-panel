import { invoke } from './desktopClient';

let cachedState = null;
let cachedLiveStatus = null;
let stateRequest = null;
let liveStatusRequest = null;

export function peekTestnetBetaState() {
  return cachedState;
}

export function peekTestnetBetaLiveStatus() {
  return cachedLiveStatus;
}

export function clearTestnetBetaPageDataCache() {
  cachedState = null;
  cachedLiveStatus = null;
}

export async function fetchTestnetBetaState(options = {}) {
  const { force = false } = options;
  if (stateRequest) {
    return stateRequest;
  }

  if (!force && cachedState) {
    return cachedState;
  }

  stateRequest = invoke('testbeta_get_state')
    .then((value) => {
      cachedState = value;
      return value;
    })
    .finally(() => {
      stateRequest = null;
    });

  return stateRequest;
}

export async function fetchTestnetBetaLiveStatus(options = {}) {
  const { force = false } = options;
  if (liveStatusRequest) {
    return liveStatusRequest;
  }

  if (!force && cachedLiveStatus) {
    return cachedLiveStatus;
  }

  liveStatusRequest = invoke('testbeta_get_live_status')
    .then((value) => {
      cachedLiveStatus = value;
      return value;
    })
    .finally(() => {
      liveStatusRequest = null;
    });

  return liveStatusRequest;
}
